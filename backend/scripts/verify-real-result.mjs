// Read-only verification of an existing real run. This script never creates a task or model call.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loadContractChecker,assertExposure} from './contract-check.mjs';
const checker=await loadContractChecker(),taskId=process.argv[2];
assert.match(taskId??'',/^task_[A-Za-z0-9_-]+$/,'Usage: npm run verify:real -- task_ID');
const base=(process.env.MOTION_SMOKE_ORIGIN??'http://127.0.0.1:4011').replace(/\/$/,'');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname),'loopback only');
async function get(operationId,params={}){
  const op=checker.operations.find(o=>o.operationId===operationId),path=op.path.replace(/\{([^}]+)\}/g,(_,name)=>encodeURIComponent(({taskId,...params})[name]));
  const response=await fetch(base+path,{headers:{'X-Contract-Version':checker.version,...(process.env.MOTION_OPERATOR_TOKEN?{Authorization:'Bearer '+process.env.MOTION_OPERATOR_TOKEN}:{})},signal:AbortSignal.timeout(10000)}),data=await response.json();
  checker.checkResponse(operationId,response.status,response.headers,data);assert.equal(response.status,200,`${operationId}: ${data.error?.code}`);return data;
}
const [task,plan,result,payments,budget]=await Promise.all(['getTask','getResourcePlan','getTaskResult','listPayments','getBudget'].map(op=>get(op)));
assert.equal(task.status,'COMPLETED');assert.equal(result.status,'COMPLETED');assert.equal(result.model.mode,'LIVE_API');assert.equal(result.dataMode,'LIVE_HTTP');assert.equal(result.learningMode,'NO_ONLINE_LABELS');assert.equal(result.paymentMode,'MOCK');assert.equal(result.paidCalls,0);assert.equal(payments.items.length,0);
assertExposure(budget);for(const k of ['settledAtomic','reservedAtomic','outstandingAtomic'])assert.equal(budget[k],'0');assert.equal(budget.availableAtomic,budget.limitAtomic);
assert.ok(plan.items.every(i=>i.unitPriceCapAtomic==='0'&&i.subtotalCapAtomic==='0'));assert.equal(plan.status,'FROZEN');
assert.ok(result.model.diagnostics.length>=4);assert.ok(result.model.diagnostics.every(d=>d.status==='SUCCEEDED'&&d.httpStatus===200&&typeof d.actualModel==='string'));
assert.ok(result.model.diagnostics.some(d=>d.role==='worker'&&d.phase==='report'));for(const role of ['worker','threat','consistency'])assert.ok(result.model.diagnostics.some(d=>d.role===role));
const evidence=await Promise.all(result.evidenceIds.map(evidenceId=>get('getEvidence',{evidenceId}))),byId=new Map(evidence.map(e=>[e.evidenceId,e]));
assert.ok(result.sources.length>0);for(const source of result.sources){const e=byId.get(source.evidenceId);assert.equal(e?.sourceKind,'TOOL_RESPONSE');assert.equal(e.taskId,taskId);assert.equal(e.contentHash,source.contentHash);assert.equal(e.trust,'EXTERNAL_UNTRUSTED');}
for(const e of evidence)for(const parent of e.parentIds)assert.ok(byId.has(parent),'complete provenance closure');
const refs=[...result.report.matchAll(/\[(\d+)\]/g)].map(m=>Number(m[1]));assert.ok(refs.length>0);assert.ok(refs.every(n=>n>0&&n<=result.sources.length));assert.ok(evidence.some(e=>e.sourceKind==='MODEL_OUTPUT'&&e.parentIds.some(id=>result.sources.some(s=>s.evidenceId===id))));
const serialized=JSON.stringify({task,plan,result,payments,budget,evidence});assert.doesNotMatch(serialized,/reasoning_content|<think>|"(?:apiKey|privateKey|signature|prompt|stack)"\s*:/i);if(process.env.MOTION_LLM_API_KEY)assert.ok(!serialized.includes(process.env.MOTION_LLM_API_KEY),'credential must never be public');
const tokenKeys=['promptTokens','completionTokens','totalTokens'];const observedUsage=Object.fromEntries(tokenKeys.map(key=>[key,result.model.diagnostics.every(d=>Number.isInteger(d.usage?.[key]))?result.model.diagnostics.reduce((sum,d)=>sum+d.usage[key],0):null]));
console.log(JSON.stringify({verifiedAt:new Date().toISOString(),scope:'EXISTING_REAL_MODEL_AND_PUBLIC_DATA_RUN',contractVersion:checker.version,taskId,taskStatus:task.status,sourceCount:result.sources.length,evidenceCount:evidence.length,modelCalls:result.model.diagnostics.length,actualModels:[...new Set(result.model.diagnostics.map(d=>d.actualModel))],observedUsage,modelLatencySumMs:result.model.diagnostics.reduce((sum,d)=>sum+d.latencyMs,0),paidCalls:0,chainPaymentVerified:false,formalLearningEffectVerified:false,task,result,budget,evidence},null,2));
