import {randomUUID} from 'node:crypto';
const base=(process.env.MOTION_SMOKE_ORIGIN??'http://127.0.0.1:4011').replace(/\/$/,'');
if(!['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname))throw new Error('SMOKE_REQUIRES_LOOPBACK');
const token=process.env.MOTION_OPERATOR_TOKEN;
async function request(path,{method='GET',body,etag,scenario}={}){
  const response=await fetch(base+'/api/v1'+path,{method,headers:{'X-Contract-Version':'0.2.0',...(token?{Authorization:'Bearer '+token}:{}),...(method==='POST'?{'Content-Type':'application/json','Idempotency-Key':randomUUID()}:{}),...(etag?{'If-Match':etag}:{}),...(scenario?{'X-Mock-Scenario':scenario}:{})},...(method==='POST'?{body:JSON.stringify(body??{})}:{})});
  if(response.headers.get('X-Execution-Mode')!=='MOCK')throw new Error('SMOKE_REFUSES_NON_MOCK');
  const data=await response.json();if(!response.ok)throw new Error(`${path} HTTP ${response.status}: ${data.error?.code}`);return data;
}
async function waitTask(id,predicate){const deadline=Date.now()+15000;while(Date.now()<deadline){const t=await request('/tasks/'+id);if(predicate(t))return t;await new Promise(r=>setTimeout(r,25));}throw new Error('LOCAL_SMOKE_TASK_TIMEOUT');}
const catalog=await request('/catalog');
if(catalog.vendors.some(v=>v.billing?.kind==='FREE_PUBLIC_DATA'))throw new Error('SANDBOX_SMOKE_REQUIRES_EXPLICIT_SANDBOX_SERVER; use verify:real for an existing live task');
const results=[];
for(const scenario of ['normal','blocked','review','unknown','lesson']){
  let t=await request('/tasks',{method:'POST',scenario,body:{goal:'比较已授权供应商的交付资料。',allowedVendorIds:[catalog.vendors[0].vendorId],budgetAtomic:'1000000',maxPaidCalls:3,expiresAt:new Date(Date.now()+3600000).toISOString()}});
  await request(`/tasks/${t.taskId}/plan`,{method:'POST',etag:t.etag});
  t=await waitTask(t.taskId,t=>t.status==='AWAITING_AUTHORIZATION');
  const plan=await request(`/tasks/${t.taskId}/resource-plan`);
  t=await request(`/tasks/${t.taskId}/authorize`,{method:'POST',etag:t.etag,body:{planHash:plan.planHash}});
  await request(`/tasks/${t.taskId}/runs`,{method:'POST',etag:t.etag,body:{authorizationVersion:t.authorization.version}});
  t=await waitTask(t.taskId,t=>['PAUSED_REVIEW','COMPLETED','FAILED','AWAITING_SETTLEMENT'].includes(t.status));
  let simulatedUserChoice=null;
  if(t.status==='PAUSED_REVIEW'){
    const list=await request(`/tasks/${t.taskId}/reviews`),review=list.items.find(r=>r.status==='PENDING');
    // Fixed, explicitly simulated user policy, only after the server proved MOCK.
    simulatedUserChoice=scenario==='review'?'APPROVE':'REJECT';
    await request(`/tasks/${t.taskId}/reviews/${review.reviewId}/resolve`,{method:'POST',etag:review.etag,body:{choice:simulatedUserChoice,snapshotHash:review.snapshotHash}});
    t=await waitTask(t.taskId,t=>['COMPLETED','FAILED','AWAITING_SETTLEMENT'].includes(t.status));
  }
  const payments=await request(`/tasks/${t.taskId}/payments`),lessons=await request(`/tasks/${t.taskId}/lessons`);
  results.push({scenario,taskId:t.taskId,status:t.status,executionMode:t.executionMode,simulatedUserChoice,payments:payments.items.map(p=>({state:p.state,decision:p.decision.type,hardGate:p.decision.hardGate,amountAtomic:p.amountAtomic,authorizationStatus:p.authorizationStatus,transactionHash:p.receipt.transactionHash})),budget:t.budget,activeLessons:lessons.items.filter(l=>l.status==='ACTIVE').length,memoryVersion:lessons.memoryVersion,summary:t.summary});
}
console.log(JSON.stringify({checkedAt:new Date().toISOString(),layer:'LIVE_LOCAL_MOCK_PROVIDER',base,chainPaymentVerified:false,realModelEffectVerified:false,results},null,2));
const expected={normal:'COMPLETED',blocked:'FAILED',review:'COMPLETED',unknown:'AWAITING_SETTLEMENT',lesson:'FAILED'};
if(results.some(r=>r.status!==expected[r.scenario])||results[0].budget.settledAtomic==='0'||results[1].budget.settledAtomic!=='0'||results[3].budget.outstandingAtomic==='0'||results[4].activeLessons<1)process.exitCode=1;
