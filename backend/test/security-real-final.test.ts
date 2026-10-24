import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {OpenAICompatibleProvider} from '../src/agents/provider.js';
import {createProcurementWorkflow,type RunOptions} from '../src/agents/workflow.js';
import type {LiveResourceReader} from '../src/agents/live-workflow.js';
import {EvidenceGraph} from '../src/agents/provenance.js';
import {DefenseMemoryStore} from '../src/memory/store.js';
import {REAL_RESOURCE_CATALOG,REAL_RESOURCE_CATALOG_VERSION} from '../src/resources/index.js';
import {MotionService} from '../src/service.js';
import {AppStore,type TaskRecord} from '../src/storage.js';
import {RunBoundary} from '../src/boundary.js';
import type {Catalog,ProviderCallDiagnostic,ProviderDiagnosticListener,Role,RoleProvider,TaskInput,WorkflowResult} from '../src/agents/types.js';

// All data/model transports below are in-process doubles. No .env or paid endpoint is read/called.
const base=JSON.parse(readFileSync(new URL('../vendor/contract/fixtures/catalog.json',import.meta.url),'utf8'));
const catalog:Catalog={schemaVersion:'0.1.0',catalogVersion:REAL_RESOURCE_CATALOG_VERSION,asset:base.asset,vendors:REAL_RESOURCE_CATALOG.map(v=>({vendorId:v.vendorId,name:v.name,payTo:null,toolId:v.toolId,routeId:v.routeId,resourceKind:v.resourceKind,description:v.description,toolDescriptorHash:v.toolDescriptorHash,billing:v.billing,source:v.source}))};
const task:TaskInput={taskId:'task_independent_real',goal:'按授权来源比较 ETH 与 Base，说明数据局限',allowedVendorIds:catalog.vendors.map(v=>v.vendorId),budgetAtomic:'1000000',maxPaidCalls:3,expiresAt:'2099-01-01T00:00:00.000Z'};
type ReportInput={phase?:string;sources?:{number:number;evidenceId:string;url:string}[]};
class OfflineModel implements RoleProvider {
  readonly mode='OPENAI_COMPATIBLE_API' as const;listeners=new Set<ProviderDiagnosticListener>();calls=0;fail=false;inconsistentIds=false;provided:ReportInput['sources'];
  onDiagnostic(fn:ProviderDiagnosticListener){this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
  async call(role:Role,input:unknown){
    this.calls++;if(this.fail)throw new Error('OFFLINE_MODEL_UNAVAILABLE');const value=input as ReportInput;
    const d:ProviderCallDiagnostic={callId:'model_independent_'+this.calls,role,...(role==='worker'?{phase:value.phase==='report'?'report' as const:'select' as const}:{}),requestedModel:'offline-model',actualModel:'offline-model',startedAt:new Date().toISOString(),latencyMs:0,status:'SUCCEEDED',httpStatus:200,maxOutputTokens:384,thinking:'disabled'};this.listeners.forEach(fn=>fn(d));
    if(role!=='worker')return{verdict:'ALLOW',reasonCode:'PLAN_MATCH'};
    if(value.phase!=='report')return{selectedVendorIds:[catalog.vendors[2]!.vendorId,catalog.vendors[0]!.vendorId]};
    this.provided=value.sources;return{report:'第一个授权来源的观察 [1]；第二个授权来源的观察 [2]。',sourceEvidenceIds:(this.inconsistentIds?value.sources!.slice(0,1):value.sources!).map(source=>source.evidenceId)};
  }
}
const offlineReader:LiveResourceReader=async input=>{
  const item=input.plan.items.find(i=>i.itemId===input.planItemId)!,v=REAL_RESOURCE_CATALOG.find(v=>v.vendorId===item.vendorId)!;
  // Finish in the reverse of plan order to exercise the published citation mapping.
  await new Promise(resolve=>setTimeout(resolve,(3-REAL_RESOURCE_CATALOG.indexOf(v))*5));
  return{resourceId:v.resourceId,vendorId:v.vendorId,toolId:v.toolId,routeId:v.routeId,text:'OFFLINE source '+v.vendorId,data:{fixture:true},raw:{fixture:true},source:v.source,observedAt:new Date().toISOString(),sourceTimestamp:null,contentHash:'sha256:'+'1'.repeat(64),rawContentHash:'sha256:'+'2'.repeat(64),requestHash:'sha256:'+'3'.repeat(64),responseBytes:50,sourceResponseHashes:[],responseMediaTypes:['application/json'],transport:'LIVE_HTTP',billing:v.billing};
};
function setup(model=new OfflineModel(),reader:LiveResourceReader=offlineReader){const memory=new DefenseMemoryStore(),workflow=createProcurementWorkflow({catalog,memory,provider:model,resourceMode:'live',resourceReader:reader}),plan=workflow.plan(task);plan.status='FROZEN';return{model,memory,workflow,plan};}

test('reverse completion and a selected subset preserve report [n] to public sources order',async()=>{
  const s=setup();try{let payments=0;const result=await s.workflow.run({task,plan:s.plan,authorizationVersion:1,onIntent:async()=>{payments++;throw new Error('PAYMENT_FORBIDDEN');}});assert.equal(result.status,'COMPLETED');assert.ok(s.model.provided);const sources=result.publicResult!.sources;for(const source of s.model.provided)assert.equal(sources[source.number-1]!.evidenceId,source.evidenceId);assert.equal(payments,0);assert.equal(result.publicResult!.paidCalls,0);assert.equal(result.publicResult!.learningMode,'NO_ONLINE_LABELS');assert.equal(s.memory.list().length,0);}finally{s.memory.close();}
});

test('inconsistent numeric citations and declared evidence IDs cannot become a completed report',async()=>{
  const model=new OfflineModel();model.inconsistentIds=true;const s=setup(model);try{const result=await s.workflow.run({task,plan:s.plan,authorizationVersion:1});assert.equal(result.status,'FAILED');assert.equal(result.deliveries.length,0);}finally{s.memory.close();}
});

test('failed model or failed source cannot publish a sandbox replacement as real completion',async()=>{
  const model=new OfflineModel();model.fail=true;
  for(const s of [setup(model),setup(new OfflineModel(),async()=>{throw new Error('OFFLINE_SOURCE_UNAVAILABLE');})])try{const result=await s.workflow.run({task,plan:s.plan,authorizationVersion:1});assert.equal(result.status,'FAILED');assert.equal(result.deliveries.length,0);assert.equal(result.publicResult!.paidCalls,0);assert.equal(result.publicResult!.learningMode,'NO_ONLINE_LABELS');assert.doesNotMatch(result.publicResult!.report,/delivery lead time|采购流程模拟完成/);}finally{s.memory.close();}
});

test('model success text cannot expose the configured API credential in a public report',async()=>{
  const fakeKey='offline_secret_canary_no_real_credential';const provider=new OpenAICompatibleProvider({baseURL:'https://model.invalid/v1',model:'offline-model',apiKey:fakeKey},async()=>new Response(JSON.stringify({model:'offline-model',choices:[{finish_reason:'stop',message:{content:JSON.stringify({report:`Leaked credential ${fakeKey} [1]`,sourceEvidenceIds:['evidence_offline']})}}]}),{status:200,headers:{'content-type':'application/json'}}));
  await assert.rejects(provider.call('worker',{phase:'report',sources:[{evidenceId:'evidence_offline'}]}),(error:unknown)=>{assert.ok(error instanceof Error);assert.ok(!String(error).includes(fakeKey));assert.ok(!JSON.stringify(error).includes(fakeKey));return true;});
});

test('B binds the report citation order and rejects a reordered result or replaced report',async()=>{
  const s=setup(),store=new AppStore(':memory:');
  try{
    const boundary=new RunBoundary({taskId:task.taskId,goal:task.goal,planHash:s.plan.planHash,authorizationVersion:1,memoryVersion:s.memory.version,catalog,store});
    const output=await s.workflow.run({task,plan:s.plan,authorizationVersion:1,onEvidence:records=>boundary.registerEvidence(records)});assert.equal(output.status,'COMPLETED');
    const fixture=JSON.parse(readFileSync(new URL('../vendor/contract/fixtures/normal-task.json',import.meta.url),'utf8'));
    const record={input:{goal:task.goal,allowedVendorIds:task.allowedVendorIds,budgetAtomic:task.budgetAtomic,maxPaidCalls:task.maxPaidCalls,expiresAt:task.expiresAt},scenario:'normal',owner:'offline',plan:s.plan,snapshot:{...fixture,taskId:task.taskId,status:'RUNNING',goal:task.goal,allowedVendorIds:task.allowedVendorIds,planHash:s.plan.planHash,planId:s.plan.planId,authorization:{...fixture.authorization,status:'ACTIVE',version:1,planHash:s.plan.planHash,goalHash:s.plan.goalHash,catalogVersion:catalog.catalogVersion},budget:{...fixture.budget,taskId:task.taskId}}} as TaskRecord;
    const host=Object.create(MotionService.prototype) as MotionService;
    Object.assign(host,{options:{resourceMode:'live'},catalog,memory:s.memory,store,ledger:{budget:()=>record.snapshot.budget},get:()=>record,change:(t:TaskRecord)=>store.putTask(t)});
    host.complete(task.taskId,output);assert.equal(host.getTaskResult(record).report,output.publicResult!.report);
    const replacement=structuredClone(output);replacement.publicResult!.report+=' A replaced factual assertion [1].';assert.throws(()=>host.complete(task.taskId,replacement),/TASK_RESULT_REPORT_EVIDENCE_REQUIRED/);
    const reordered=structuredClone(output),sources=reordered.publicResult!.sources;[sources[0],sources[1]]=[sources[1]!,sources[0]!];
    assert.throws(()=>host.complete(task.taskId,reordered),/TASK_RESULT_REPORT_(?:EVIDENCE|CITATION_ORDER)_REQUIRED/,'the same report hash and parent set cannot authorize swapping the meaning of [1] and [2]');
  }finally{store.close();s.memory.close();}
});

test('cancellation rejects late evidence and leaves the cancelled summary/event sequence unchanged',{timeout:5000},async()=>{
  const s=setup(),store=new AppStore(':memory:');let entered!:()=>void,rejectRun!:(error:Error)=>void;const started=new Promise<void>(resolve=>{entered=resolve;});let captured:RunOptions|undefined;
  const fixture=JSON.parse(readFileSync(new URL('../vendor/contract/fixtures/normal-task.json',import.meta.url),'utf8'));
  const authorization={authorizationId:'auth_independent',version:1,status:'ACTIVE' as const,planHash:s.plan.planHash,goalHash:s.plan.goalHash,catalogVersion:catalog.catalogVersion,budgetAtomic:task.budgetAtomic,maxPaidCalls:task.maxPaidCalls,expiresAt:task.expiresAt,authorizedAt:new Date().toISOString(),revokedAt:null};
  const record:TaskRecord={input:{goal:task.goal,allowedVendorIds:task.allowedVendorIds,budgetAtomic:task.budgetAtomic,maxPaidCalls:task.maxPaidCalls,expiresAt:task.expiresAt},scenario:'normal',owner:'offline',plan:s.plan,snapshot:{...fixture,taskId:task.taskId,status:'READY',goal:task.goal,allowedVendorIds:task.allowedVendorIds,planHash:s.plan.planHash,planId:s.plan.planId,authorization,budget:{...fixture.budget,taskId:task.taskId}}};
  const host=Object.create(MotionService.prototype) as MotionService;
  const runtime=new Proxy({run:async(input:RunOptions)=>{captured=input;entered();return new Promise<WorkflowResult>((_resolve,reject)=>{rejectRun=reject;});}},{get:(target,key)=>key in target?target[key as keyof typeof target]:()=>{}});
  Object.assign(host,{options:{resourceMode:'live'},catalog,memory:s.memory,store,runtime,closed:false,background:new Set<Promise<void>>(),pending:new Map(),ledger:{revoke:()=>{},budget:()=>record.snapshot.budget},get:()=>record,change:(t:TaskRecord)=>{t.snapshot.version++;t.snapshot.lastEventSeq++;store.putTask(t);}});
  try{
    host.run(record,1);await started;assert.ok(captured);host.revoke(record,true);const summary=record.snapshot.summary,seq=record.snapshot.lastEventSeq;
    const graph=new EvidenceGraph(task.taskId);graph.add('USER_INPUT',task.goal);graph.add('TRUSTED_CATALOG',JSON.stringify(catalog));
    try{captured.onEvidence?.(graph.all());}catch{/* rejecting a cancelled runtime callback is permitted */}
    captured.onEvent?.({type:'AGENT_STEP',summary:JSON.stringify({kind:'MODEL_CALL',role:'worker',phase:'report',status:'SUCCEEDED',latencyMs:1})});
    assert.equal(store.list('evidence',task.taskId).length,0,'cancelled tasks must not accept late evidence');assert.equal(record.snapshot.summary,summary);assert.equal(record.snapshot.lastEventSeq,seq,'late telemetry must not advance the cancelled task');
  }finally{rejectRun?.(new Error('OFFLINE_TEST_STOP'));await Promise.allSettled(host.background);store.close();s.memory.close();}
});
