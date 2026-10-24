import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createBackendHarness, assertExposure, errorBody } from '../scripts/contract-check.mjs';

test('task and idempotent creation survive a real SQLite close/reopen',async t=>{
  const h=await createBackendHarness(t);const first=await h.createDraft();
  await h.restart();
  const restored=await h.request('getTask',{params:{taskId:first.data.taskId}});assert.equal(restored.response.status,200);assert.equal(restored.data.goal,first.body.goal);assert.equal(restored.data.budget.limitAtomic,first.body.budgetAtomic);
  const replay=await h.request('createTask',{body:first.body,idempotencyKey:first.key,headers:{'X-Mock-Scenario':'normal'}});assert.equal(replay.response.status,201);assert.equal(replay.response.headers.get('idempotency-replayed'),'true');assert.deepEqual(replay.data,first.data,'durable replay returns the original result');
  const changed=await h.request('createTask',{body:{...first.body,goal:'changed request'},idempotencyKey:first.key,headers:{'X-Mock-Scenario':'normal'}});assert.equal(changed.response.status,409);assert.equal(errorBody(changed.data).error.code,'IDEMPOTENCY_CONFLICT');
});

test('concurrent requests with one idempotency key create one task',async t=>{
  const h=await createBackendHarness(t),key=randomUUID(),body={goal:'并发创建同一个逻辑任务',allowedVendorIds:['vendor_alpha'],budgetAtomic:'1000000',maxPaidCalls:3,expiresAt:new Date(Date.now()+3600000).toISOString()};
  const responses=await Promise.all(Array.from({length:6},()=>h.request('createTask',{body,idempotencyKey:key})));
  for(const response of responses)assert.equal(response.response.status,201);
  assert.equal(new Set(responses.map(response=>response.data.taskId)).size,1);
  assert.ok(responses.some(response=>response.response.headers.get('idempotency-replayed')==='true'));
});

test('concurrent run attempts cannot debit the same authorized plan twice',async t=>{
  const h=await createBackendHarness(t);const{taskId,task}=await h.readyTask();
  const attempts=await Promise.all([1,2].map(()=>h.request('runTask',{params:{taskId},ifMatch:task.etag,body:{authorizationVersion:task.authorization.version}})));
  assert.equal(attempts.filter(response=>response.response.status===202).length,1);
  assert.ok(attempts.some(response=>[409,412].includes(response.response.status)));
  const complete=await h.pollTask(taskId,'COMPLETED'),payments=await h.request('listPayments',{params:{taskId}});assertExposure(complete.budget);
  const settled=payments.data.items.filter(payment=>payment.state==='SETTLED').reduce((sum,payment)=>sum+BigInt(payment.amountAtomic),0n);
  assert.equal(BigInt(complete.budget.settledAtomic),settled);assert.equal(payments.data.items.length,1,'one initial planned logical purchase');
});

test('UNKNOWN exposure persists through restart and is not refunded by revocation',async t=>{
  const h=await createBackendHarness(t);const{taskId}=await h.startTask({scenario:'unknown'});const before=await h.pollTask(taskId,'AWAITING_SETTLEMENT');
  assert.ok(BigInt(before.budget.outstandingAtomic)>0n);assert.equal(before.budget.settledAtomic,'0');
  const paymentsBefore=await h.request('listPayments',{params:{taskId}});const ids=paymentsBefore.data.items.map(payment=>payment.paymentId);const outstanding=before.budget.outstandingAtomic;
  await h.restart();
  const restored=await h.request('getTask',{params:{taskId}});assert.equal(restored.data.budget.outstandingAtomic,outstanding);assertExposure(restored.data.budget);
  const revoked=await h.request('revokeTaskAuthorization',{params:{taskId},ifMatch:restored.data.etag});assert.equal(revoked.response.status,200);assert.ok(revoked.data.authorization);assert.equal(revoked.data.authorization.status,'REVOKED');assert.equal(revoked.data.budget.outstandingAtomic,outstanding);
  const runAgain=await h.request('runTask',{params:{taskId},ifMatch:revoked.data.etag,body:{authorizationVersion:revoked.data.authorization.version}});assert.ok([409,422].includes(runAgain.response.status));
  await h.restart();const final=await h.request('getTask',{params:{taskId}});assert.equal(final.data.budget.outstandingAtomic,outstanding);const paymentsAfter=await h.request('listPayments',{params:{taskId}});assert.deepEqual(paymentsAfter.data.items.map(payment=>payment.paymentId),ids,'restart must not silently re-sign a new payment');
});

test('review approval and its idempotent replay remain one payment after restart',async t=>{
  const h=await createBackendHarness(t);const{taskId}=await h.startTask({scenario:'review'});await h.pollTask(taskId,'PAUSED_REVIEW');const reviews=await h.request('listReviews',{params:{taskId}}),review=reviews.data.items.find(value=>value.status==='PENDING');assert.ok(review);
  const operation={params:{taskId,reviewId:review.reviewId},ifMatch:review.etag,idempotencyKey:randomUUID(),body:{choice:'APPROVE',snapshotHash:review.snapshotHash}};
  const approved=await h.request('resolveReview',operation);assert.equal(approved.response.status,200);const complete=await h.pollTask(taskId,'COMPLETED');const spent=complete.budget.settledAtomic;
  await h.restart();const replay=await h.request('resolveReview',operation);assert.equal(replay.response.status,200);assert.equal(replay.response.headers.get('idempotency-replayed'),'true');assert.deepEqual(replay.data,approved.data);
  const current=await h.request('getTask',{params:{taskId}});assert.equal(current.data.budget.settledAtomic,spent);
  const paymentList=await h.request('listPayments',{params:{taskId}});assert.equal(paymentList.data.items.filter(payment=>payment.state==='SETTLED').length,1);
});

test('SSE replay survives restart and close stops the actual HTTP listener',async t=>{
  const h=await createBackendHarness(t);const{taskId}=await h.startTask();const complete=await h.pollTask(taskId,'COMPLETED');assert.ok(complete.lastEventSeq>0);
  await h.restart();const replay=await h.events(taskId,Math.max(0,complete.lastEventSeq-2),{until:event=>event.seq===complete.lastEventSeq});assert.equal(replay.response?.status,200);assert.ok(replay.events.length>0);assert.equal(replay.events.at(-1)?.seq,complete.lastEventSeq);
  const oldBase=h.base;await h.close();assert.equal(h.app.server.listening,false);await assert.rejects(fetch(oldBase+'/api/v1/catalog',{headers:{'X-Contract-Version':'0.2.0',Authorization:`Bearer ${h.token}`}}));
  const diagnostics=typeof h.app.diagnostics==='function'?h.app.diagnostics():h.app.diagnostics;
  if(diagnostics){assert.equal(diagnostics.closed,true);assert.equal(diagnostics.backgroundJobs,0);assert.equal(diagnostics.pendingReviews,0);}
  if(diagnostics?.signerPid){let running=true;try{process.kill(diagnostics.signerPid,0);}catch{running=false;}assert.equal(running,false,'signer child process survived close');}
});
