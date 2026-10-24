import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackendHarness, loadContractChecker, assertExposure } from '../scripts/contract-check.mjs';

test('published provider snapshot is immutable and has exactly 19 operations',async()=>{
  const checker=await loadContractChecker();
  assert.equal(checker.version,'0.2.0');
  assert.equal(checker.operations.length,19);
  assert.equal(checker.operations.filter(operation=>operation.method==='POST').length,7);
});

test('actual backend serves all 18 published operations with schema-valid views',async t=>{
  const h=await createBackendHarness(t);
  const catalog=await h.request('getCatalog');assert.equal(catalog.response.status,200);
  assert.equal(catalog.data.asset.network,'eip155:84532');
  const {taskId}=await h.startTask({scenario:'review'});
  const paused=await h.pollTask(taskId,'PAUSED_REVIEW');assert.equal(paused.authMode,'OPERATOR_SESSION');
  const plan=await h.request('getResourcePlan',{params:{taskId}});assert.equal(plan.data.status,'FROZEN');
  const payments=await h.request('listPayments',{params:{taskId}});assert.equal(payments.response.status,200);assert.ok(payments.data.items.length>0);
  const payment=payments.data.items.find(value=>value.decision.type==='REVIEW');assert.ok(payment,'review scenario must expose a review decision');
  const detail=await h.request('getPayment',{params:{taskId,paymentId:payment.paymentId}});assert.equal(detail.response.status,200);
  const decision=await h.request('getDecision',{params:{taskId,paymentId:payment.paymentId}});assert.equal(decision.data.hardGate,'PASS');
  assert.ok(decision.data.evidenceIds.length>0);
  const evidence=await h.request('getEvidence',{params:{taskId,evidenceId:decision.data.evidenceIds[0]}});assert.equal(evidence.response.status,200);
  const budget=await h.request('getBudget',{params:{taskId}});assertExposure(budget.data);assert.equal(budget.data.outstandingAtomic,'0');
  const reviews=await h.request('listReviews',{params:{taskId}});const review=reviews.data.items.find(value=>value.status==='PENDING');assert.ok(review);
  const approved=await h.request('resolveReview',{params:{taskId,reviewId:review.reviewId},ifMatch:review.etag,body:{choice:'APPROVE',snapshotHash:review.snapshotHash}});assert.equal(approved.response.status,200);assert.equal(approved.data.review.status,'APPROVED');
  const complete=await h.pollTask(taskId,'COMPLETED');
  const result=await h.request('getTaskResult',{params:{taskId}});assert.equal(result.response.status,200);assert.equal((result.data as {dataMode:string}).dataMode,'SANDBOX');
  const lessons=await h.request('listLessons',{params:{taskId}});assert.equal(lessons.response.status,200);
  const events=await h.events(taskId,Math.max(0,complete.lastEventSeq-2),{until:event=>event.seq===complete.lastEventSeq});assert.equal(events.response?.status,200);assert.ok(events.events.length>0);
  assert.ok(events.events.every((event,index,all)=>index===0||event.seq>all[index-1].seq),'SSE seq must strictly increase');
  const draft=await h.createDraft();const cancelled=await h.request('cancelTask',{params:{taskId:draft.data.taskId},ifMatch:draft.data.etag});assert.equal(cancelled.response.status,200);assert.equal(cancelled.data.status,'CANCELLED');
  const ready=await h.readyTask();const revoked=await h.request('revokeTaskAuthorization',{params:{taskId:ready.taskId},ifMatch:ready.task.etag});assert.equal(revoked.response.status,200);assert.ok(revoked.data.authorization);assert.equal(revoked.data.authorization.status,'REVOKED');
  assert.deepEqual([...h.observed].sort(),h.checker.operations.map(operation=>operation.operationId).sort());
});

for(const scenario of ['normal','blocked','review','unknown','lesson']){
  test(`actual backend ${scenario} path is distinct from the fixture-only mock`,async t=>{
    const h=await createBackendHarness(t);
    const {taskId}=await h.startTask({scenario});
    if(scenario==='lesson'){
      const learningState=await h.pollTask(taskId,snapshot=>['PAUSED_REVIEW','COMPLETED','FAILED'].includes(snapshot.status));
      if(learningState.status==='PAUSED_REVIEW'){
        const reviews=await h.request('listReviews',{params:{taskId}}),review=reviews.data.items.find(value=>value.status==='PENDING');assert.ok(review,'learning demonstration must expose the exact approval it requires');
        const approval=await h.request('resolveReview',{params:{taskId,reviewId:review.reviewId},ifMatch:review.etag,body:{choice:'APPROVE',snapshotHash:review.snapshotHash}});assert.equal(approval.response.status,200);
      }
    }
    const task=await h.pollTask(taskId,scenario==='review'?'PAUSED_REVIEW':scenario==='unknown'?'AWAITING_SETTLEMENT':snapshot=>['COMPLETED','FAILED'].includes(snapshot.status));
    const payments=await h.request('listPayments',{params:{taskId}});assert.ok(payments.data.items.length>0);
    for(const payment of payments.data.items){
      assert.equal(payment.taskId,taskId);
      assert.equal(payment.executionMode,'MOCK','no credentials are configured; never claim testnet execution');
      assert.notEqual(payment.authorizationStatus,'SIGNED_TESTNET');assert.equal(payment.receipt.transactionHash,null);
      if(payment.decision.hardGate==='BLOCK'){assert.equal(payment.decision.type,'BLOCK');assert.equal(payment.authorizationStatus,'NOT_CREATED');assert.equal(payment.state,'REJECTED');}
    }
    assertExposure(task.budget);
    if(scenario==='normal')assert.ok(BigInt(task.budget.settledAtomic)>0n,'sandbox allowed payment should settle in the real backend ledger');
    if(scenario==='blocked')assert.equal(task.budget.settledAtomic,'0');
    if(scenario==='review'){assert.equal(task.pendingReviewCount,1);assert.equal(task.budget.outstandingAtomic,'0');assert.equal(task.budget.settledAtomic,'0');}
    if(scenario==='unknown'){assert.ok(BigInt(task.budget.outstandingAtomic)>0n);assert.equal(task.budget.settledAtomic,'0');}
    if(scenario==='lesson'){const result=await h.request('listLessons',{params:{taskId}});const active=result.data.items.filter(lesson=>lesson.status==='ACTIVE');assert.ok(active.length>0,'lesson scenario must publish a verified lesson, not just change the task text');for(const lesson of active){assert.equal(lesson.promotion.originReplayPassed,true);assert.ok(lesson.promotion.variantPassed>=2);assert.ok(lesson.promotion.benignPassed>=2);assert.equal(lesson.promotion.regressionPassed,true);assert.equal(lesson.promotion.permissionsUnchanged,true);}}
  });
}

test('missing resources return public schema-valid 404 errors',async t=>{
  const h=await createBackendHarness(t);const draft=await h.createDraft();
  const checks:[string,Record<string,string>][]=[['getTask',{taskId:'task_missing'}],['getPayment',{taskId:draft.data.taskId,paymentId:'payment_missing'}],['getDecision',{taskId:draft.data.taskId,paymentId:'payment_missing'}],['getEvidence',{taskId:draft.data.taskId,evidenceId:'evidence_missing'}]];
  for(const[operationId,params]of checks){const result=await h.request(operationId,{params});assert.equal(result.response.status,404);}
});
