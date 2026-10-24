import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {RunBoundary, RunBoundaryError} from '../src/boundary.js';
import {AppStore} from '../src/storage.js';
import {createProcurementWorkflow} from '../src/agents/workflow.js';
import {DeterministicSandboxProvider} from '../src/agents/provider.js';
import {DefenseMemoryStore} from '../src/memory/store.js';
import {digest} from '../src/agents/provenance.js';
import type {Catalog, Evidence, ProcurementIntent, TaskInput} from '../src/agents/types.js';

const catalog=JSON.parse(readFileSync(new URL('../vendor/contract/fixtures/catalog.json',import.meta.url),'utf8')) as Catalog;
const task:TaskInput={taskId:'task_boundary',goal:'Compare only authorized delivery reports',allowedVendorIds:['vendor_alpha','vendor_beta'],budgetAtomic:'1000000',maxPaidCalls:2,expiresAt:'2099-01-01T00:00:00.000Z'};
async function fixture(){
  const memory=new DefenseMemoryStore();try{
    const workflow=createProcurementWorkflow({catalog,memory,provider:new DeterministicSandboxProvider()}),plan={...workflow.plan(task),status:'FROZEN' as const};
    const result=await workflow.run({task,plan,authorizationVersion:1,onIntent:async()=>({verdict:'ALLOW',state:'SETTLED',receipt:{status:'SIMULATED',transactionHash:null,mockReceiptId:'mock_boundary'}})});
    assert.equal(result.intents.length,2);return{evidence:result.evidence,intent:result.intents[0]!,plan};
  }finally{memory.close();}
}
function context(t:{after(fn:()=>void):void},planHash:string){const store=new AppStore(':memory:');t.after(()=>store.close());return{store,boundary:new RunBoundary({taskId:task.taskId,goal:task.goal,planHash,authorizationVersion:1,memoryVersion:'memory_v0',catalog,store})};}
const denied=(callback:()=>void)=>assert.throws(callback,RunBoundaryError);

test('domain B accepts real graph evidence out of order, immutable replays and a bound intent',async t=>{
  const f=await fixture(),{store,boundary}=context(t,f.plan.planHash);boundary.registerEvidence([...f.evidence].reverse());boundary.registerEvidence(f.evidence);boundary.checkIntent(f.intent);
  assert.equal(store.list('evidence',task.taskId).length,f.evidence.length);
});

test('domain B rejects another task, frozen plan, authorization version or memory package',async t=>{
  const f=await fixture(),{boundary}=context(t,f.plan.planHash);boundary.registerEvidence(f.evidence);
  for(const change of [{taskId:'task_other'},{planHash:'sha256:'+'0'.repeat(64)},{authorizationVersion:2},{memoryVersion:'memory_v99'}])denied(()=>boundary.checkIntent({...f.intent,...change}));
});

test('evidence IDs cannot overwrite another task or mutate existing bytes',async t=>{
  const f=await fixture(),{store,boundary}=context(t,f.plan.planHash);boundary.registerEvidence(f.evidence);const record=f.evidence.find(e=>e.sourceKind==='TOOL_RESPONSE')!;
  denied(()=>boundary.registerEvidence([{...record,excerpt:'replacement'}]));
  const other={...record,evidenceId:'evidence_foreign',taskId:'task_other'};store.put('evidence',other.evidenceId,other.taskId,other);
  denied(()=>boundary.registerEvidence([{...record,evidenceId:other.evidenceId}]));
  assert.equal(store.get<Evidence>('evidence',other.evidenceId,'task_other')!.excerpt,other.excerpt);
});

test('domain B verifies trusted roots instead of trusting A source labels',async t=>{
  const f=await fixture(),{boundary}=context(t,f.plan.planHash),user=f.evidence.find(e=>e.sourceKind==='USER_INPUT')!,cat=f.evidence.find(e=>e.sourceKind==='TRUSTED_CATALOG')!;
  denied(()=>boundary.registerEvidence([{...user,contentHash:digest('forged user permission')} ]));
  denied(()=>boundary.registerEvidence([{...cat,contentHash:digest('forged catalog')} ]));
  denied(()=>boundary.registerEvidence([{...user,sourceKind:'HOST_CHECK',trust:'HOST_OBSERVED'}]));
});

test('external and derived sources cannot upgrade trust or invent missing parents',async t=>{
  const f=await fixture(),{boundary}=context(t,f.plan.planHash),raw=f.evidence.find(e=>e.sourceKind==='TOOL_RESPONSE')!,worker=f.evidence.find(e=>e.sourceKind==='MODEL_OUTPUT')!;
  for(const target of [raw,worker])denied(()=>boundary.registerEvidence(f.evidence.map(e=>e.evidenceId===target.evidenceId?{...e,trust:'HOST_OBSERVED'}:e)));
  denied(()=>boundary.registerEvidence(f.evidence.map(e=>e.evidenceId===raw.evidenceId?{...e,parentIds:['evidence_missing'],parentClosureHash:digest(['evidence_missing'])}:e)));
  denied(()=>boundary.registerEvidence(f.evidence.map(e=>e.evidenceId===raw.evidenceId?{...e,parentIds:[e.evidenceId],parentClosureHash:digest([e.evidenceId])}:e)));
});

test('wrong evidence closure hashes and partial batches do not leave accepted fragments',async t=>{
  const f=await fixture(),{store,boundary}=context(t,f.plan.planHash),raw=f.evidence.find(e=>e.sourceKind==='TOOL_RESPONSE')!;
  denied(()=>boundary.registerEvidence(f.evidence.map(e=>e.evidenceId===raw.evidenceId?{...e,parentClosureHash:digest([])}:e)));
  assert.equal(store.list('evidence',task.taskId).length,0,'the batch must be checked before any storage write');
  denied(()=>boundary.registerEvidence([{...raw,taskId:'task_other'}]));
});

test('domain B requires the complete consumed source closure for each proposed payment',async t=>{
  const f=await fixture(),{boundary}=context(t,f.plan.planHash);boundary.registerEvidence(f.evidence);
  const raw=f.evidence.find(e=>e.sourceKind==='TOOL_RESPONSE')!,worker=f.evidence.find(e=>e.sourceKind==='MODEL_OUTPUT')!;
  const partial=f.intent.evidenceIds.filter(id=>id!==raw.evidenceId);denied(()=>boundary.checkIntent({...f.intent,evidenceIds:partial,parentClosureHash:digest([...partial].sort())}));
  const withoutWorker=f.intent.evidenceIds.filter(id=>id!==worker.evidenceId);denied(()=>boundary.checkIntent({...f.intent,evidenceIds:withoutWorker,parentClosureHash:digest([...withoutWorker].sort())}));
});

test('private intent schema rejects unknown privileges, arbitrary URLs and lossy money',async t=>{
  const f=await fixture(),{boundary}=context(t,f.plan.planHash);boundary.registerEvidence(f.evidence);
  for(const change of [{operatorApproved:true},{url:'https://unplanned.invalid/pay'},{amountAtomic:10},{amountAtomic:'1.5'},{amountAtomic:'-1'},{amountAtomic:'0'},{method:'POST'},{selectors:{url:'https://unplanned.invalid'}},{asset:{...catalog.asset,network:'eip155:1'}},{facts:{...f.intent.facts,operatorApproved:true}}])denied(()=>boundary.checkIntent({...f.intent,...change}));
});

test('reviewers must be distinct bounded roles and cannot have their verdict downgraded',async t=>{
  const f=await fixture(),{boundary}=context(t,f.plan.planHash);boundary.registerEvidence(f.evidence);
  const reviewer=f.intent.reviewers[0]!;
  for(const reviewers of [[reviewer],[reviewer,reviewer],[{...reviewer,role:'OPERATOR'},f.intent.reviewers[1]!],[{...reviewer,verdict:'BLOCK'},f.intent.reviewers[1]!],[{...reviewer,evidenceIds:['evidence_unknown']},f.intent.reviewers[1]!]])denied(()=>boundary.checkIntent({...f.intent,reviewers}));
  denied(()=>boundary.checkIntent({...f.intent,facts:{...f.intent.facts,externalInstruction:true}}));
  denied(()=>boundary.checkIntent({...f.intent,facts:{...f.intent.facts,hasUntrustedAncestor:false}}));
});

test('A cannot call a verdict an approval by attaching a host-only review field',async t=>{
  const f=await fixture(),{boundary}=context(t,f.plan.planHash);boundary.registerEvidence(f.evidence);
  denied(()=>boundary.checkIntent({...f.intent,reviewResolution:'APPROVED'}));
  const blocked:ProcurementIntent={...f.intent,decision:'BLOCK',reviewers:f.intent.reviewers.map(r=>({...r,verdict:'BLOCK'}))};boundary.checkIntent(blocked);
});
