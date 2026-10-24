import {createProcurementWorkflow,type RunOptions} from '../agents/workflow.js';
import {createProviderFromEnv} from '../agents/provider.js';
import {DefenseMemoryStore} from '../memory/store.js';
import {identifier} from '../agents/provenance.js';
import type {Catalog,IntentResult} from '../agents/types.js';
let workflow:ReturnType<typeof createProcurementWorkflow>|undefined;let catalog:Catalog|undefined;let resourceMode:'live'|'sandbox'='sandbox';let memory:DefenseMemoryStore|undefined;let closing=false;let gateTimeoutMs=121000;
const canceled=new Set<string>();const pending=new Map<string,{runId:string;resolve:(result:IntentResult)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
const send=(message:unknown)=>{if(process.connected)process.send?.(message as any);};
function abort(runId:string){canceled.add(runId);for(const [id,entry] of pending){if(entry.runId===runId){clearTimeout(entry.timer);entry.reject(new Error('AGENT_RUNTIME_CANCELED'));pending.delete(id);}}}
async function run(runId:string,input:RunOptions){
  if(!workflow||closing){send({type:'run-error',runId});return;}
  try{
    // Each live run owns its provider and diagnostic buffer; concurrent tasks never
    // read or attribute another task's model calls to their public result.
    const current=resourceMode==='live'?createProcurementWorkflow({catalog:catalog!,memory:memory!,provider:createProviderFromEnv(process.env,{strictReal:true}),resourceMode}):workflow;
    const result=await current.run({...input,onEvidence:evidence=>{if(canceled.has(runId)||closing)throw new Error('AGENT_RUNTIME_CANCELED');send({type:'evidence',runId,evidence});},onEvent:event=>{if(canceled.has(runId)||closing)throw new Error('AGENT_RUNTIME_CANCELED');send({type:'event',runId,event});},onIntent:async(intent,evidence)=>{
      if(canceled.has(runId)||closing)throw new Error('AGENT_RUNTIME_CANCELED');const requestId=identifier('request');return new Promise<IntentResult>((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('PARENT_GATE_TIMEOUT'));},gateTimeoutMs);pending.set(requestId,{runId,resolve,reject,timer});send({type:'intent',runId,requestId,intent,evidence,transport:input.scenarioId==='unknown'?'UNKNOWN':'SIMULATED'});});
    }});if(!canceled.has(runId)&&!closing)send({type:'result',runId,result});
  }catch{if(!canceled.has(runId)&&!closing)send({type:'run-error',runId});}finally{canceled.delete(runId);}
}
process.on('message',(raw:unknown)=>{if(!raw||typeof raw!=='object')return;const message=raw as any;
  if(message.type==='init'){
    if(workflow)return;try{if(!Number.isSafeInteger(message.gateTimeoutMs)||message.gateTimeoutMs<1000||message.gateTimeoutMs>43200000||!['live','sandbox'].includes(message.resourceMode))throw new Error('INVALID_RUNTIME_CONFIGURATION');gateTimeoutMs=message.gateTimeoutMs;resourceMode=message.resourceMode;catalog=structuredClone(message.catalog);memory=new DefenseMemoryStore(message.memoryPath);workflow=createProcurementWorkflow({catalog:catalog!,memory,provider:createProviderFromEnv(process.env,{strictReal:resourceMode==='live'}),resourceMode});send({type:'ready',providerMode:workflow.providerMode});}catch{send({type:'init-error'});}return;
  }
  if(message.type==='run'){void run(message.runId,message.input);return;}
  if(message.type==='intent-result'){const entry=pending.get(message.requestId);if(!entry||entry.runId!==message.runId)return;clearTimeout(entry.timer);pending.delete(message.requestId);entry.resolve(message.result);return;}
  if(message.type==='cancel'){abort(message.runId);return;}
  if(message.type==='close'){closing=true;for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(new Error('AGENT_RUNTIME_CLOSED'));}pending.clear();memory?.close();process.disconnect?.();process.exit(0);}
});
process.on('disconnect',()=>{if(!closing){closing=true;for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(new Error('PARENT_DISCONNECTED'));}memory?.close();process.exit(0);}});
