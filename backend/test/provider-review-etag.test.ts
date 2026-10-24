import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createBackendHarness,assertExposure} from '../scripts/contract-check.mjs';

// Private inspection of this test's generated SQLite files; no live app data or wallet is used.
function signingAndSettlement(dbPath:string,taskId:string){
  const db=new DatabaseSync(`${dbPath}.ledger`,{readOnly:true});
  try{
    const payments=(db.prepare('SELECT data,stage,permit_id FROM mg_payments WHERE task_id=? ORDER BY payment_id').all(taskId) as {data:string;stage:string|null;permit_id:string|null}[]).map(row=>{
      const payment=JSON.parse(row.data) as {paymentId:string;state:string;amountAtomic:string;nonce:string|null;signerAddress:string|null;authorizationHash:string|null};
      return{paymentId:payment.paymentId,state:payment.state,amountAtomic:payment.amountAtomic,nonce:payment.nonce,signerAddress:payment.signerAddress,authorizationHash:payment.authorizationHash,stage:row.stage,permitId:row.permit_id};
    });
    const nonces=db.prepare('SELECT asset,sender,nonce FROM mg_sandbox_nonces ORDER BY asset,sender,nonce').all();
    return{payments,nonces};
  }finally{db.close();}
}

for(const choice of ['APPROVE','REJECT'] as const){
  test(`resolveReview ${choice}: nested ETag survives replay, restart and legacy headerless replay without another authorization`,async t=>{
    const h=await createBackendHarness(t),{taskId}=await h.startTask({scenario:'review'});await h.pollTask(taskId,'PAUSED_REVIEW');
    const reviews=await h.request('listReviews',{params:{taskId}}),review=reviews.data.items.find(value=>value.status==='PENDING');assert.ok(review);
    const key=randomUUID(),operation={params:{taskId,reviewId:review.reviewId},ifMatch:review.etag,idempotencyKey:key,body:{choice,snapshotHash:review.snapshotHash}};
    const resolved=await h.request('resolveReview',operation);assert.equal(resolved.response.status,200);assert.equal(resolved.data.review.status,choice==='APPROVE'?'APPROVED':'REJECTED');
    const tag=resolved.data.review.etag;assert.equal(resolved.response.headers.get('etag'),tag);assert.notEqual(tag,review.etag);assert.notEqual(tag,resolved.data.task.etag);
    const wrongHeader=new Headers(resolved.response.headers);wrongHeader.set('ETag','"view_incorrect_wrapper_hash"');
    assert.throws(()=>h.checker.checkResponse('resolveReview',200,wrongHeader,resolved.data),/nested review resource/,'the shared checker must reject the original generic wrapper ETag bug');
    const complete=await h.pollTask(taskId,choice==='APPROVE'?'COMPLETED':'FAILED');assertExposure(complete.budget);
    const baseline=signingAndSettlement(h.dbPath,taskId),spent=complete.budget.settledAtomic;
    if(choice==='APPROVE'){
      assert.ok(BigInt(spent)>0n);assert.equal(baseline.payments.length,1);assert.equal(baseline.payments[0]!.state,'SETTLED');assert.ok(baseline.payments[0]!.nonce);assert.ok(baseline.payments[0]!.authorizationHash);assert.equal(baseline.nonces.length,1);
    }else{assert.equal(spent,'0');assert.equal(baseline.payments.length,0);assert.equal(baseline.nonces.length,0);}
    async function replay(){
      // Replay intentionally keeps the stale pre-resolution If-Match. Idempotency returns the original result.
      const again=await h.request('resolveReview',operation);assert.equal(again.response.status,200);assert.equal(again.response.headers.get('idempotency-replayed'),'true');assert.equal(again.response.headers.get('etag'),tag);assert.equal(again.response.headers.get('etag'),again.data.review.etag);assert.deepEqual(again.data,resolved.data);
      const task=await h.request('getTask',{params:{taskId}});assert.equal(task.data.budget.settledAtomic,spent);assert.equal(task.data.budget.outstandingAtomic,'0');assertExposure(task.data.budget);
      const payments=await h.request('listPayments',{params:{taskId}});assert.equal(payments.data.items.length,1);assert.equal(payments.data.items[0]!.state,choice==='APPROVE'?'SETTLED':'REJECTED');
      assert.deepEqual(signingAndSettlement(h.dbPath,taskId),baseline,'replay must not create a new nonce, signer authorization or settlement');
    }
    await replay();await h.restart();await replay();
    await h.close();
    const db=new DatabaseSync(h.dbPath);
    try{
      const row=db.prepare('SELECT scope,response FROM app_idempotency WHERE key=?').get(key) as {scope:string;response:string}|undefined;assert.ok(row);
      const stored=JSON.parse(row.response) as {schema:string;headers?:Record<string,string>;body:unknown};assert.equal(stored.schema,'ResolveReviewResult');assert.equal(stored.headers?.ETag,tag,'new responses persist the review resource ETag');delete stored.headers;
      const update=db.prepare('UPDATE app_idempotency SET response=? WHERE scope=? AND key=?').run(JSON.stringify(stored),row.scope,key);assert.equal(update.changes,1);
    }finally{db.close();}
    await h.restart();await replay();
  });
}
