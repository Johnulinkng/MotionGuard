import {fork,type ChildProcess} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {digest,identifier} from '../agents/provenance.js';
import type {Catalog,IntentResult,ProviderMode,WorkflowResult} from '../agents/types.js';
import type {RunOptions} from '../agents/workflow.js';

export interface AgentRuntimeOptions {catalog:Catalog;memoryPath?:string;modelEnv?:NodeJS.ProcessEnv;runTimeoutMs?:number;resourceMode?:'live'|'sandbox'}
export const MODEL_ENV_KEYS=['MOTION_LLM_BASE_URL','MOTION_LLM_MODEL','MOTION_LLM_API_KEY','MOTION_LLM_MODE'] as const;
/** A does not inherit NODE_OPTIONS, wallet credentials, operator tokens, RPCs or .env. */
export function buildAgentEnvironment(source:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv {
  const env:NodeJS.ProcessEnv={};for(const name of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','LANG','LC_ALL'])if(source[name])env[name]=source[name];for(const name of MODEL_ENV_KEYS)if(source[name])env[name]=source[name];return env;
}
type CachedIntent={fingerprint:string;result:Promise<IntentResult>};
type Pending={input:RunOptions;resolve:(result:WorkflowResult)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout;requests:Map<string,CachedIntent>};
export class AgentRuntime {
  private child:ChildProcess;private pending=new Map<string,Pending>();private canceledTasks=new Set<string>();private closed=false;private ready:Promise<void>;private resolveReady!:()=>void;private rejectReady!:(error:Error)=>void;private exitPromise:Promise<void>;private mode:ProviderMode;
  constructor(private options:AgentRuntimeOptions){
    const env=buildAgentEnvironment(options.modelEnv??process.env);this.mode=['MOTION_LLM_BASE_URL','MOTION_LLM_MODEL','MOTION_LLM_API_KEY'].every(key=>!env[key])?'DETERMINISTIC_SANDBOX':'OPENAI_COMPATIBLE_API';this.ready=new Promise((resolve,reject)=>{this.resolveReady=resolve;this.rejectReady=reject;});
    // Fixed loader avoids inheriting --test, inspector flags or parent preload modules.
    this.child=fork(fileURLToPath(new URL('./worker.ts',import.meta.url)),[],{cwd:fileURLToPath(new URL('../../',import.meta.url)),env,execArgv:['--import','tsx'],stdio:['ignore','ignore','ignore','ipc'],serialization:'json'});
    this.exitPromise=new Promise(resolve=>this.child.once('exit',()=>{this.rejectReady(new Error('AGENT_RUNTIME_EXITED'));this.rejectPending('AGENT_RUNTIME_EXITED');resolve();}));
    this.child.on('error',()=>{this.rejectReady(new Error('AGENT_RUNTIME_START_FAILED'));this.rejectPending('AGENT_RUNTIME_START_FAILED');});
    this.child.on('message',(message:unknown)=>{void this.handle(message);});
    this.send({type:'init',catalog:structuredClone(options.catalog),memoryPath:options.memoryPath??':memory:',gateTimeoutMs:(options.runTimeoutMs??120000)+1000,resourceMode:options.resourceMode??'sandbox'});
    // Prevent an unobserved startup rejection if the owner closes before its first run.
    void this.ready.catch(()=>{});
  }
  get providerMode(){return this.mode;}
  get pid(){return this.child.pid;}
  private send(message:unknown){if(this.child.connected)this.child.send(message as any,()=>{});}
  private rejectPending(reason:string){for(const entry of this.pending.values()){clearTimeout(entry.timer);entry.requests.clear();entry.reject(new Error(reason));}this.pending.clear();}
  private async handle(raw:unknown){
    if(!raw||typeof raw!=='object')return;const message=raw as any;
    if(message.type==='ready'){this.mode=message.providerMode;this.resolveReady();return;}
    if(message.type==='init-error'){this.rejectReady(new Error('AGENT_RUNTIME_CONFIGURATION_FAILED'));return;}
    const entry=this.pending.get(message.runId);if(!entry)return;
    if(message.type==='evidence'){try{entry.input.onEvidence?.(message.evidence);}catch{clearTimeout(entry.timer);entry.requests.clear();this.pending.delete(message.runId);this.send({type:'cancel',runId:message.runId});entry.reject(new Error('EVIDENCE_REGISTRATION_FAILED'));}return;}
    if(message.type==='event'){try{entry.input.onEvent?.(message.event);}catch{/* operator telemetry cannot grant a payment */}return;}
    if(message.type==='intent'){
      if(typeof message.requestId!=='string'||!message.requestId||message.requestId.length>256)return;
      const reply=(result:IntentResult)=>{if(this.pending.get(message.runId)===entry)this.send({type:'intent-result',runId:message.runId,requestId:message.requestId,result});};
      let fingerprint:string;try{fingerprint=digest({intent:message.intent,evidence:message.evidence,transport:message.transport});}catch{reply({verdict:'BLOCK',reasonCodes:['INVALID_AGENT_INTENT']});return;}
      const cached=entry.requests.get(message.requestId);
      if(cached){if(cached.fingerprint!==fingerprint){reply({verdict:'BLOCK',reasonCodes:['IPC_REQUEST_CONFLICT']});return;}reply(await cached.result);return;}
      // Cache the promise before invoking either host callback: retries cannot create
      // a second review/payment, including while the first exact review is pending.
      const result=Promise.resolve().then(async():Promise<IntentResult>=>{
        if(this.closed||this.pending.get(message.runId)!==entry)return {verdict:'BLOCK',reasonCodes:['AGENT_RUNTIME_CANCELED']};
        const intent=message.intent;
        if(!intent||typeof intent!=='object'||!Array.isArray(message.evidence)||intent.taskId!==entry.input.task.taskId||intent.planHash!==entry.input.plan.planHash||intent.authorizationVersion!==entry.input.authorizationVersion)return {verdict:'BLOCK',reasonCodes:['AGENT_INTENT_CONTEXT_MISMATCH']};
        entry.input.onEvidence?.(message.evidence);
        return entry.input.onIntent?await entry.input.onIntent(intent,message.evidence):{verdict:intent.decision,state:intent.decision==='ALLOW'?(message.transport==='UNKNOWN'?'UNKNOWN':'SETTLED'):intent.decision==='BLOCK'?'REJECTED':'REVIEW',receipt:{status:intent.decision==='ALLOW'?message.transport:'NONE',transactionHash:null,mockReceiptId:intent.decision==='ALLOW'?identifier('mock'):null}};
      }).catch(():IntentResult=>({verdict:'BLOCK',reasonCodes:['PAYMENT_GATE_UNAVAILABLE']}));
      entry.requests.set(message.requestId,{fingerprint,result});reply(await result);return;
    }
    if(message.type==='result'||message.type==='run-error'){clearTimeout(entry.timer);entry.requests.clear();this.pending.delete(message.runId);if(message.type==='result')entry.resolve(message.result);else entry.reject(new Error('AGENT_RUNTIME_RUN_FAILED'));}
  }
  async run(input:RunOptions):Promise<WorkflowResult>{
    if(this.closed)throw new Error('AGENT_RUNTIME_CLOSED');if(this.canceledTasks?.has(input.task.taskId))throw new Error('AGENT_RUNTIME_CANCELED');await this.ready;if(this.closed)throw new Error('AGENT_RUNTIME_CLOSED');if(this.canceledTasks?.has(input.task.taskId))throw new Error('AGENT_RUNTIME_CANCELED');const runId=identifier('run');
    const boundInput:RunOptions={...input,task:structuredClone(input.task),plan:structuredClone(input.plan)};
    return new Promise((resolve,reject)=>{const requests=new Map<string,CachedIntent>();const timer=setTimeout(()=>{requests.clear();this.pending.delete(runId);this.send({type:'cancel',runId});reject(new Error('AGENT_RUNTIME_TIMEOUT'));},this.options.runTimeoutMs??120000);this.pending.set(runId,{input:boundInput,resolve,reject,timer,requests});this.send({type:'run',runId,input:{task:boundInput.task,plan:boundInput.plan,authorizationVersion:boundInput.authorizationVersion,scenarioId:boundInput.scenarioId??'normal',...(boundInput.attack?{attack:boundInput.attack}:{})}});});
  }
  cancelTask(taskId:string):number {this.canceledTasks.add(taskId);let count=0;for(const [runId,entry]of this.pending){if(entry.input.task.taskId!==taskId)continue;clearTimeout(entry.timer);entry.requests.clear();this.pending.delete(runId);this.send({type:'cancel',runId});entry.reject(new Error('AGENT_RUNTIME_CANCELED'));count++;}return count;}
  async close():Promise<void>{if(this.closed){await this.exitPromise;return;}this.closed=true;this.rejectReady(new Error('AGENT_RUNTIME_CLOSED'));this.rejectPending('AGENT_RUNTIME_CLOSED');this.canceledTasks.clear();this.send({type:'close'});const killTimer=setTimeout(()=>this.child.kill(),1000);killTimer.unref();await this.exitPromise;clearTimeout(killTimer);}
}
export const createAgentRuntime=(options:AgentRuntimeOptions)=>new AgentRuntime(options);
