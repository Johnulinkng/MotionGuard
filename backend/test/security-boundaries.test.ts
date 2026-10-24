import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createBackendHarness, errorBody } from '../scripts/contract-check.mjs';

test('all 19 operator operations require an actual configured bearer session',async t=>{
  const h=await createBackendHarness(t);
  for(const operation of h.checker.operations){
    const result=await h.request(operation.operationId,{params:{taskId:'task_absent',paymentId:'payment_absent',evidenceId:'evidence_absent',reviewId:'review_absent'},auth:false,ifMatch:'"absent:v1"'});
    assert.equal(result.response.status,401,operation.operationId);
  }
  const wrong=await h.request('getCatalog',{auth:'incorrect-session'});assert.equal(wrong.response.status,401);
  const good=await h.request('getCatalog');assert.equal(good.response.status,200);
});

test('contract version, mutation idempotency and strong task ETag are enforced',async t=>{
  const h=await createBackendHarness(t);
  const version=await h.request('getCatalog',{contractVersion:null});assert.equal(version.response.status,400);
  const noKey=await h.request('createTask',{idempotencyKey:null,body:{}});assert.equal(noKey.response.status,400);
  const draft=await h.createDraft();const params={taskId:draft.data.taskId};
  const missing=await h.request('planTask',{params});assert.equal(missing.response.status,428);
  const wildcard=await h.request('planTask',{params,ifMatch:'*'});assert.equal(wildcard.response.status,412);
  const stale=await h.request('planTask',{params,ifMatch:'"task_wrong:v1"'});assert.equal(stale.response.status,412);
  const unchanged=await h.request('getTask',{params});assert.equal(unchanged.data.status,'DRAFT');
});

test('M0 freezes goal, plan, vendor and budget; no mutation expands authorization',async t=>{
  const h=await createBackendHarness(t);const{taskId,task,plan}=await h.readyTask();
  const params={taskId};
  const replan=await h.request('planTask',{params,ifMatch:task.etag});assert.equal(replan.response.status,409);
  const expanded=await h.request('authorizeTask',{params,ifMatch:task.etag,body:{planHash:plan.planHash,budgetAtomic:'999999999999999',allowedVendorIds:['vendor_gamma']}});assert.equal(expanded.response.status,422);
  const current=await h.request('getTask',{params});assert.ok(current.data.authorization);assert.equal(current.data.authorization.planHash,task.authorization.planHash);assert.equal(current.data.budget.limitAtomic,task.budget.limitAtomic);assert.deepEqual(current.data.allowedVendorIds,task.allowedVendorIds);
  const frozen=await h.request('getResourcePlan',{params});assert.equal(frozen.data.planHash,plan.planHash);assert.equal(frozen.data.status,'FROZEN');
  for(const path of [`/api/v1/tasks/${taskId}`,`/api/v1/tasks/${taskId}/resource-plan`,`/api/v1/tasks/${taskId}/authorize`]){
    const response=await fetch(h.base+path,{method:'PATCH',headers:{Authorization:`Bearer ${h.token}`,'X-Contract-Version':'0.2.0','Content-Type':'application/json','Idempotency-Key':randomUUID(),'If-Match':current.data.etag},body:JSON.stringify({budgetAtomic:'999999999'})});assert.ok([404,405].includes(response.status),'no PATCH expansion route');h.checker.checkSchema('ApiError',await response.json());
  }
});

test('public task creation rejects forged authority, arbitrary URLs and lossy money',async t=>{
  const h=await createBackendHarness(t),base={goal:'仅购买授权资料',allowedVendorIds:['vendor_alpha'],budgetAtomic:'1000000',maxPaidCalls:3,expiresAt:new Date(Date.now()+3600000).toISOString()};
  for(const changed of [{budgetAtomic:1},{budgetAtomic:'0.1'},{budgetAtomic:'-1'},{budgetAtomic:'0'},{operatorApproved:true},{url:'https://not-authorized.invalid/pay'},{allowedVendorIds:['vendor_not_in_catalog']},{expiresAt:'2099-01-01T00:00:00+08:00'}]){
    const result=await h.request('createTask',{body:{...base,...changed}});assert.equal(result.response.status,422,JSON.stringify(changed));
  }
  const exact='900719925474099312345678';const result=await h.createDraft({overrides:{budgetAtomic:exact}});assert.equal(result.data.budget.limitAtomic,exact,'do not round a 24-digit string through Number');
});

test('default backend refuses mock-control headers and exposes no signer/model API',async t=>{
  const h=await createBackendHarness(t,{testScenarioHeader:false});
  const result=await h.request('createTask',{headers:{'X-Mock-Scenario':'normal'},body:{goal:'research',allowedVendorIds:['vendor_alpha'],budgetAtomic:'1000000',maxPaidCalls:3,expiresAt:new Date(Date.now()+3600000).toISOString()}});assert.ok([400,403,422].includes(result.response.status),'public scenario injection must not be accepted');
  for(const path of ['/api/v1/sign','/api/v1/signer','/api/v1/pay','/api/v1/model','/internal/sign']){
    const response=await fetch(h.base+path,{method:'POST',headers:{Authorization:`Bearer ${h.token}`,'X-Contract-Version':'0.2.0','Content-Type':'application/json','Idempotency-Key':randomUUID()},body:'{}'});assert.ok([403,404,405].includes(response.status),path);h.checker.checkSchema('ApiError',await response.json());
  }
});

test('review binds its own ETag, immutable snapshot and one exact in-plan intent',async t=>{
  const h=await createBackendHarness(t);const{taskId}=await h.startTask({scenario:'review'});const task=await h.pollTask(taskId,'PAUSED_REVIEW');const list=await h.request('listReviews',{params:{taskId}});const review=list.data.items.find(r=>r.status==='PENDING');assert.ok(review);
  const params={taskId,reviewId:review.reviewId};
  const wrongVersion=await h.request('resolveReview',{params,ifMatch:task.etag,body:{choice:'APPROVE',snapshotHash:review.snapshotHash}});assert.equal(wrongVersion.response.status,412);
  const wrongSnapshot=await h.request('resolveReview',{params,ifMatch:review.etag,body:{choice:'APPROVE',snapshotHash:'sha256:'+'0'.repeat(64)}});assert.equal(wrongSnapshot.response.status,409);
  const unchanged=await h.request('getBudget',{params:{taskId}});assert.equal(unchanged.data.settledAtomic,'0');assert.equal(unchanged.data.outstandingAtomic,'0');
  const denied=await h.request('resolveReview',{params,ifMatch:review.etag,body:{choice:'REJECT',snapshotHash:review.snapshotHash}});assert.equal(denied.response.status,200);assert.equal(denied.data.review.status,'REJECTED');
  const retry=await h.request('resolveReview',{params,ifMatch:denied.data.review.etag,body:{choice:'APPROVE',snapshotHash:review.snapshotHash}});assert.ok([409,412].includes(retry.response.status));
  const final=await h.request('getBudget',{params:{taskId}});assert.equal(final.data.settledAtomic,'0');assert.equal(final.data.outstandingAtomic,'0');
});

test('hard BLOCK has no review bypass and creates no redeemable authorization',async t=>{
  const h=await createBackendHarness(t);const{taskId}=await h.startTask({scenario:'blocked'});await h.pollTask(taskId,task=>['COMPLETED','FAILED'].includes(task.status));
  const list=await h.request('listPayments',{params:{taskId}});const payment=list.data.items.find(p=>p.decision.hardGate==='BLOCK');assert.ok(payment);assert.equal(payment.decision.type,'BLOCK');assert.equal(payment.authorizationStatus,'NOT_CREATED');
  const reviews=await h.request('listReviews',{params:{taskId}});assert.equal(reviews.data.items.filter(r=>r.paymentId===payment.paymentId&&r.status==='PENDING').length,0);
  const forged=await h.request('resolveReview',{params:{taskId,reviewId:payment.paymentId},ifMatch:'"forged:v1"',body:{choice:'APPROVE',snapshotHash:payment.requestHash}});assert.ok([404,409,422].includes(forged.response.status));
  const budget=await h.request('getBudget',{params:{taskId}});assert.equal(budget.data.settledAtomic,'0');assert.equal(budget.data.outstandingAtomic,'0');
});

test('each payment carries the closure of every resource actually exposed to its worker',async t=>{
  const h=await createBackendHarness(t);const catalog=await h.request('getCatalog');assert.ok(catalog.data.vendors.length>=2);
  const vendors=catalog.data.vendors.slice(0,2).map(v=>v.vendorId),draft=await h.createDraft({overrides:{allowedVendorIds:vendors}}),taskId=draft.data.taskId;
  const planned=await h.request('planTask',{params:{taskId},ifMatch:draft.data.etag});assert.equal(planned.response.status,202);
  const awaiting=await h.pollTask(taskId,'AWAITING_AUTHORIZATION'),plan=await h.request('getResourcePlan',{params:{taskId}});assert.equal(plan.data.items.length,2);
  const authorized=await h.request('authorizeTask',{params:{taskId},ifMatch:awaiting.etag,body:{planHash:plan.data.planHash}});assert.equal(authorized.response.status,200);assert.ok(authorized.data.authorization);
  const run=await h.request('runTask',{params:{taskId},ifMatch:authorized.data.etag,body:{authorizationVersion:authorized.data.authorization.version}});assert.equal(run.response.status,202);
  await h.pollTask(taskId,'COMPLETED');const payments=await h.request('listPayments',{params:{taskId}});assert.equal(payments.data.items.length,2);
  for(const payment of payments.data.items){
    const evidence=await Promise.all(payment.decision.evidenceIds.map(async evidenceId=>{const result=await h.request('getEvidence',{params:{taskId,evidenceId}});assert.equal(result.response.status,200);return result.data;}));
    assert.equal(evidence.filter(item=>item.sourceKind==='TOOL_RESPONSE').length,2,'both consumed resources must be in the host-owned payment provenance closure');
    assert.ok(evidence.some(item=>item.sourceKind==='MODEL_OUTPUT'&&item.trust==='EXTERNAL_UNTRUSTED'),'the worker decision inherits its consumed external sources');
    const ids=new Set(evidence.map(item=>item.evidenceId));for(const item of evidence)assert.ok(item.parentIds.every(parent=>ids.has(parent)),'source closure must include all recorded parents');
  }
});

test('expired REVIEW is denied even when the previous review ETag is supplied',async t=>{
  let clockMs=Date.now();const h=await createBackendHarness(t,{clock:()=>new Date(clockMs),reviewTtlMs:50});
  const{taskId}=await h.startTask({scenario:'review'});await h.pollTask(taskId,'PAUSED_REVIEW');const list=await h.request('listReviews',{params:{taskId}});const review=list.data.items.find(r=>r.status==='PENDING');assert.ok(review);
  clockMs+=1000;
  const result=await h.request('resolveReview',{params:{taskId,reviewId:review.reviewId},ifMatch:review.etag,body:{choice:'APPROVE',snapshotHash:review.snapshotHash}});assert.equal(result.response.status,409);assert.equal(errorBody(result.data).error.code,'REVIEW_EXPIRED');
  const budget=await h.request('getBudget',{params:{taskId}});assert.equal(budget.data.outstandingAtomic,'0');assert.equal(budget.data.settledAtomic,'0');
  const after=await h.request('listReviews',{params:{taskId}});const expiredReview=after.data.items.find(item=>item.reviewId===review.reviewId);assert.ok(expiredReview);assert.equal(expiredReview.status,'EXPIRED','expiry must persist even though the approval request returns 409');
});

test('SSE authenticates and expired cursors return 410 with a REST recovery snapshot',async t=>{
  const h=await createBackendHarness(t,{eventHistoryLimit:2});const{taskId}=await h.startTask();const complete=await h.pollTask(taskId,'COMPLETED');
  const unauthorized=await h.events(taskId,undefined,{auth:false});assert.equal(unauthorized.response?.status,401);
  const expired=await h.events(taskId,0);assert.equal(expired.response?.status,410);const expiryError=errorBody(expired.data);assert.equal(expiryError.error.code,'EVENT_CURSOR_EXPIRED');assert.ok((expiryError.error.details?.minEventSeq??0)>1);assert.equal(expiryError.error.details?.snapshotPath,`/api/v1/tasks/${taskId}`);
  const replay=await h.events(taskId,complete.lastEventSeq-1,{until:event=>event.seq===complete.lastEventSeq});assert.equal(replay.response?.status,200);assert.equal(replay.events.length,1);assert.equal(replay.events[0].seq,complete.lastEventSeq);
});
