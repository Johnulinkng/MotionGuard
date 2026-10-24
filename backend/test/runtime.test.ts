import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AgentRuntime,buildAgentEnvironment} from '../src/runtime/client.js';
import {createProcurementWorkflow} from '../src/agents/workflow.js';
import {DeterministicSandboxProvider} from '../src/agents/provider.js';
import {DefenseMemoryStore} from '../src/memory/store.js';
import type {Catalog,TaskInput} from '../src/agents/types.js';
import type {RunOptions} from '../src/agents/workflow.js';
import type {IntentResult} from '../src/agents/types.js';
const catalog=JSON.parse(readFileSync(new URL('../vendor/contract/fixtures/catalog.json',import.meta.url),'utf8')) as Catalog;
const task:TaskInput={taskId:'task_runtime',goal:'Compare authorized delivery',allowedVendorIds:['vendor_alpha'],budgetAtomic:'1000000',maxPaidCalls:1,expiresAt:'2099-01-01T00:00:00.000Z'};
function frozen(){const memory=new DefenseMemoryStore();try{return {...createProcurementWorkflow({catalog,memory,provider:new DeterministicSandboxProvider()}).plan(task),status:'FROZEN' as const};}finally{memory.close();}}
test('agent environment excludes signer, operator, RPC and inherited preload credentials',()=>{const env=buildAgentEnvironment({PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,MOTION_LLM_MODEL:'model',MOTION_LLM_API_KEY:'llm-only',SIGNER_PRIVATE_KEY:'wallet-secret',MOTION_RPC_URL:'secret-rpc',OPERATOR_TOKEN:'operator-secret',NODE_OPTIONS:'--require malicious.js'});assert.equal(env.MOTION_LLM_MODEL,'model');for(const key of ['SIGNER_PRIVATE_KEY','MOTION_RPC_URL','OPERATOR_TOKEN','NODE_OPTIONS'])assert.equal(env[key],undefined);});
test('separate agent PID executes graph and delegates all payment/evidence to parent',async()=>{const runtime=new AgentRuntime({catalog,modelEnv:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot}});try{assert.notEqual(runtime.pid,process.pid);let requests=0;const evidenceIds=new Set<string>();const result=await runtime.run({task,plan:frozen(),authorizationVersion:1,onEvidence:evidence=>evidence.forEach(e=>evidenceIds.add(e.evidenceId)),onIntent:async(intent,evidence)=>{requests++;assert.ok(intent.evidenceIds.every(id=>evidenceIds.has(id)&&evidence.some(e=>e.evidenceId===id)));return {verdict:'ALLOW',state:'SETTLED',receipt:{status:'SIMULATED',transactionHash:null,mockReceiptId:'mock_runtime'}};}});assert.equal(requests,1);assert.equal(result.status,'COMPLETED');assert.equal(result.providerMode,'DETERMINISTIC_SANDBOX');}finally{await runtime.close();}await assert.rejects(runtime.run({task,plan:frozen(),authorizationVersion:1}),/AGENT_RUNTIME_CLOSED/);});
test('runtime unknown transport remains UNKNOWN and close cancels pending runs',async()=>{const runtime=new AgentRuntime({catalog,modelEnv:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot}});try{const result=await runtime.run({task,plan:frozen(),authorizationVersion:1,scenarioId:'unknown'});assert.equal(result.status,'UNKNOWN');let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});const pending=runtime.run({task,plan:frozen(),authorizationVersion:1,onIntent:async()=>{entered();return new Promise(()=>{});}});const rejected=assert.rejects(pending,/AGENT_RUNTIME_CLOSED/);await started;await runtime.close();await rejected;}finally{await runtime.close();}});

// Exercise the B-side IPC boundary directly with hostile child messages; no test
// control path is exposed by the worker or the public REST contract.
function ipcHarness(input:RunOptions,timeoutMs=10000){
  const sent:any[]=[];const client=Object.create(AgentRuntime.prototype) as any;
  client.pending=new Map();client.closed=false;client.ready=Promise.resolve();client.options={runTimeoutMs:timeoutMs};client.send=(message:unknown)=>sent.push(message);
  return {client,sent,input,async start(){const result=client.run(input) as ReturnType<AgentRuntime['run']>;await Promise.resolve();const run=sent.find(message=>message.type==='run');assert.ok(run);return {result,runId:run.runId as string,entry:client.pending.get(run.runId)};}};
}
function ipcIntent(runId:string,planHash:string,requestId='request_repeat'){
  return {type:'intent',runId,requestId,transport:'SIMULATED',intent:{intentId:'intent_ipc',taskId:task.taskId,planHash,authorizationVersion:1,decision:'ALLOW',amountAtomic:'10'},evidence:[{evidenceId:'evidence_ipc',contentHash:'sha256:original'}]};
}

test('IPC retries share one in-flight promise and settled result; conflicting body never invokes B twice',async()=>{
  let calls=0,evidenceCalls=0;let finish!:(result:IntentResult)=>void;
  const plan=frozen();const h=ipcHarness({task,plan,authorizationVersion:1,onEvidence:()=>{evidenceCalls++;},onIntent:async()=>{calls++;return new Promise(resolve=>{finish=resolve;});}});
  const {result,runId,entry}=await h.start();const rejected=assert.rejects(result,/TEST_CLEANUP/);
  try{
    const message=ipcIntent(runId,plan.planHash);const first=h.client.handle(message);const second=h.client.handle(structuredClone(message));await Promise.resolve();
    assert.equal(calls,1);assert.equal(evidenceCalls,1);assert.equal(entry.requests.size,1);
    for(const mutation of [
      {...message,intent:{...message.intent,amountAtomic:'11'}},
      {...message,evidence:[{...message.evidence[0],contentHash:'sha256:changed'}]},
      {...message,transport:'UNKNOWN'}
    ]){await h.client.handle(mutation);assert.deepEqual(h.sent.at(-1).result,{verdict:'BLOCK',reasonCodes:['IPC_REQUEST_CONFLICT']});}
    assert.equal(calls,1);assert.equal(evidenceCalls,1);
    const approved:IntentResult={verdict:'ALLOW',state:'SETTLED',reviewResolution:'APPROVED',receipt:{status:'SIMULATED',transactionHash:null,mockReceiptId:'mock_exact'}};
    finish(approved);await Promise.all([first,second]);await h.client.handle(structuredClone(message));
    const allowed=h.sent.filter(message=>message.type==='intent-result'&&message.result.verdict==='ALLOW');assert.equal(allowed.length,3);for(const reply of allowed)assert.deepEqual(reply.result,approved);assert.equal(calls,1);assert.equal(evidenceCalls,1);
  }finally{h.client.rejectPending('TEST_CLEANUP');await rejected;assert.equal(entry.requests.size,0);}
});

test('IPC rejects another task, plan or authorization before evidence registration and payment gate',async()=>{
  let calls=0,evidenceCalls=0;const plan=frozen();const h=ipcHarness({task,plan,authorizationVersion:1,onEvidence:()=>{evidenceCalls++;},onIntent:async()=>{calls++;return {verdict:'ALLOW'};}});
  const {result,runId,entry}=await h.start();const rejected=assert.rejects(result,/TEST_CLEANUP/);
  try{
    const base=ipcIntent(runId,plan.planHash);
    for(const [index,patch] of [{taskId:'task_other'},{planHash:'sha256:other'},{authorizationVersion:2}].entries()){
      const message={...base,requestId:`request_wrong_${index}`,intent:{...base.intent,...patch}};await h.client.handle(message);await h.client.handle(structuredClone(message));assert.deepEqual(h.sent.at(-1).result,{verdict:'BLOCK',reasonCodes:['AGENT_INTENT_CONTEXT_MISMATCH']});
    }
    assert.equal(calls,0);assert.equal(evidenceCalls,0);assert.equal(entry.requests.size,3);
    // Changing the caller's plan after run() cannot change the trusted binding.
    plan.planHash='sha256:mutated-after-run';await h.client.handle({...base,requestId:'request_original_snapshot'});assert.equal(calls,1);assert.equal(h.sent.at(-1).result.verdict,'ALLOW');
  }finally{h.client.rejectPending('TEST_CLEANUP');await rejected;assert.equal(entry.requests.size,0);}
});

test('IPC timeout clears request cache and a late gate result cannot reply to a canceled run',async()=>{
  let finish!:(result:IntentResult)=>void;let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});const plan=frozen();
  const h=ipcHarness({task,plan,authorizationVersion:1,onIntent:async()=>{entered();return new Promise(resolve=>{finish=resolve;});}},40);
  const {result,runId,entry}=await h.start();const timedOut=assert.rejects(result,/AGENT_RUNTIME_TIMEOUT/);const handling=h.client.handle(ipcIntent(runId,plan.planHash));await started;assert.equal(entry.requests.size,1);await timedOut;
  assert.equal(h.client.pending.size,0);assert.equal(entry.requests.size,0);finish({verdict:'ALLOW',state:'SETTLED'});await handling;assert.equal(h.sent.filter(message=>message.type==='intent-result').length,0);
});
