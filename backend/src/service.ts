import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import type { ServerResponse } from 'node:http';
import { AppStore, type TaskRecord } from './storage.js';
import type * as Public from './generated/contracts.js';
import { SqliteLedger } from './ledger/sqlite.js';
import { PaymentKernel } from './payment/kernel.js';
import { createSandboxSigner } from './signer/ipc.js';
import { hashResourcePlan, sha256 } from './payment/canonical.js';
import type { PaymentIntent, PaymentRecord, PrivateSigner, TrustedRoute } from './payment/types.js';
import { createProcurementWorkflow } from './agents/workflow.js';
import type { IntentResult, ProcurementIntent, WorkflowResult } from './agents/types.js';
import { createProviderFromEnv } from './agents/provider.js';
import { DefenseMemoryStore } from './memory/store.js';
import { AgentRuntime } from './runtime/client.js';
import { RunBoundary } from './boundary.js';
import { assertSchema } from './contracts.js';
import { REAL_RESOURCE_CATALOG, REAL_RESOURCE_CATALOG_VERSION } from './resources/catalog.js';
import { digest, redact } from './agents/provenance.js';

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message = code, readonly details?: Public.ApiError['error']['details']) {super(message);}
}
export const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-','')}`;
export interface ServiceOptions {
  dbPath?: string; operatorToken?: string; authRequired?: boolean; executionMode?: 'MOCK'|'TESTNET';
  scenario?: 'normal'|'blocked'|'review'|'unknown'|'lesson'; clock?:()=>Date; reviewTtlMs?: number;
  eventHistoryLimit?: number; testScenarioHeader?: boolean; allowedOrigins?: string[];
  resourceMode?: 'live'|'sandbox';
}
type Pending = { intent: ProcurementIntent; paymentId: string; resolve?: (v: IntentResult)=>void };
export class MotionService {
  readonly store: AppStore; readonly ledger: SqliteLedger; readonly memory: DefenseMemoryStore;
  readonly catalog: Public.Catalog; readonly subscribers = new Map<string, Set<ServerResponse>>();
  readonly pending = new Map<string, Pending>(); readonly background = new Set<Promise<void>>();
  readonly workflow: ReturnType<typeof createProcurementWorkflow>; readonly kernel: PaymentKernel;
  readonly runtime: AgentRuntime; private temporaryMemoryDirectory?: string;
  closed = false; private readonly signer: PrivateSigner;
  private constructor(readonly options: ServiceOptions, signer: PrivateSigner) {
    this.signer=signer;
    const path=options.dbPath??'data/private/motion.sqlite';
    this.store=new AppStore(path);
    this.ledger=new SqliteLedger({path:path===':memory:'?path:`${path}.ledger`,executionMode:'MOCK',now:()=>Math.floor(this.now().getTime()/1000)});
    if(path===':memory:')this.temporaryMemoryDirectory=mkdtempSync(join(tmpdir(),'motion-memory-'));
    const memoryPath=this.temporaryMemoryDirectory?join(this.temporaryMemoryDirectory,'memory.sqlite'):`${path}.memory`;
    this.memory=new DefenseMemoryStore(memoryPath);
    const fixtureCatalog:Public.Catalog=JSON.parse(readFileSync(new URL('../vendor/contract/fixtures/catalog.json',import.meta.url),'utf8'));
    this.catalog=options.resourceMode==='live'?{schemaVersion:'0.1.0',catalogVersion:REAL_RESOURCE_CATALOG_VERSION,asset:fixtureCatalog.asset,vendors:REAL_RESOURCE_CATALOG.map(v=>({vendorId:v.vendorId,name:v.name,payTo:v.payTo,toolId:v.toolId,routeId:v.routeId,resourceKind:v.resourceKind,description:v.description,toolDescriptorHash:v.toolDescriptorHash,source:structuredClone(v.source),billing:structuredClone(v.billing)}))}:fixtureCatalog;
    this.workflow=createProcurementWorkflow({catalog:this.catalog,memory:this.memory,provider:createProviderFromEnv(process.env,{strictReal:options.resourceMode==='live'}),resourceMode:options.resourceMode??'sandbox',now:()=>this.now()});
    this.runtime=new AgentRuntime({catalog:this.catalog,memoryPath,resourceMode:options.resourceMode??'sandbox',runTimeoutMs:Math.max(120000,(options.reviewTtlMs??300000)+60000)});
    this.kernel=new PaymentKernel({ledger:this.ledger,signer});
    this.ledger.fundSandbox(signer.address,'999999999999999999999999999999');
    this.ledger.recover();
    for(const task of this.store.tasks()) {
      if(['RUNNING','PLANNING'].includes(task.snapshot.status)) {task.snapshot.status='FAILED';this.change(task,'task.updated','运行被中断，请新建任务；已有授权仍按账本保留。');}
      if(task.snapshot.authorization) this.syncBudget(task);
    }
  }
  static async create(options: ServiceOptions) {
    if(options.resourceMode!==undefined&&!['live','sandbox'].includes(options.resourceMode))throw new HttpError(422,'INVALID_RESOURCE_MODE');
    if(options.resourceMode==='live'&&options.testScenarioHeader)throw new HttpError(422,'LIVE_RESOURCES_FORBID_MOCK_SCENARIOS');
    // Validate real configuration before creating any subprocess or persistent store.
    createProviderFromEnv(process.env,{strictReal:options.resourceMode==='live'});
    if(options.executionMode==='TESTNET') throw new HttpError(503,'TESTNET_PREFLIGHT_REQUIRED','测试网付款尚未完成真实集成验收；当前 HTTP provider 仅支持 MOCK。');
    const signer=await createSandboxSigner({now:()=>Math.floor((options.clock?.()??new Date()).getTime()/1000)});
    try{return new MotionService(options,signer);}catch(e){await signer.close();throw e;}
  }
  now(){return this.options.clock?.()??new Date();}
  get(taskId:string):TaskRecord {const t=this.store.getTask(taskId);if(!t)throw new HttpError(404,'TASK_NOT_FOUND');return t;}
  taskInput(t:TaskRecord){return {taskId:t.snapshot.taskId,...t.input};}
  private emptyBudget(taskId:string,limit:string):Public.BudgetView {return {schemaVersion:'0.1.0',taskId,asset:this.catalog.asset,limitAtomic:limit,settledAtomic:'0',reservedAtomic:'0',outstandingAtomic:'0',availableAtomic:limit,version:1};}
  create(input:Public.CreateTask,scenario:string,owner:string):TaskRecord {
    if(BigInt(input.budgetAtomic)<=0n||Date.parse(input.expiresAt)<=this.now().getTime()||input.allowedVendorIds.some(v=>!this.catalog.vendors.some(x=>x.vendorId===v)))throw new HttpError(422,'INVALID_AUTHORIZATION_INPUT');
    const taskId=id('task'),now=this.now().toISOString();
    const snapshot:Public.TaskSnapshot={schemaVersion:'0.1.0',taskId,version:0,etag:`"${taskId}:v0"`,status:'DRAFT',goal:input.goal,allowedVendorIds:input.allowedVendorIds,executionMode:'MOCK',authMode:this.options.authRequired?'OPERATOR_SESSION':'MOCK_UNAUTHENTICATED',planId:null,planHash:null,authorization:null,activeMemoryVersion:this.memory.version,budget:this.emptyBudget(taskId,input.budgetAtomic),pendingReviewCount:0,lastEventSeq:0,createdAt:now,updatedAt:now,summary:this.options.resourceMode==='live'?'准备读取公开资料并调用模型；尚未执行任务或链上付款。':'本地沙箱；未执行链上付款。'};
    const t={snapshot,input,scenario,owner,plan:null};this.change(t,'task.created','任务已创建，尚未读取外部内容。');return t;
  }
  change(t:TaskRecord,type:Public.EventEnvelope['type'],summary:string,resourceType:Public.EventEnvelope['resourceType']='TASK',resourceId:string=t.snapshot.taskId){
    t.snapshot.version++;t.snapshot.etag=`"${t.snapshot.taskId}:v${t.snapshot.version}"`;t.snapshot.updatedAt=this.now().toISOString();t.snapshot.lastEventSeq++;
    t.snapshot.activeMemoryVersion=this.memory.version;t.snapshot.pendingReviewCount=this.store.list<Public.ReviewView>('review',t.snapshot.taskId).filter(r=>r.status==='PENDING').length;
    const event:Public.EventEnvelope={schemaVersion:'0.1.0',eventId:`${t.snapshot.taskId}:${t.snapshot.lastEventSeq}`,taskId:t.snapshot.taskId,seq:t.snapshot.lastEventSeq,type,occurredAt:t.snapshot.updatedAt,aggregateVersion:t.snapshot.version,executionMode:'MOCK',summary:summary.slice(0,600),resourceId,resourceType};
    assertSchema('EventEnvelope',event);assertSchema('TaskSnapshot',t.snapshot);
    this.store.putTask(t);this.store.addEvent(event,this.options.eventHistoryLimit??2000);
    for(const response of this.subscribers.get(t.snapshot.taskId)??[])response.write(`id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  launch(work:()=>Promise<void>){const p=Promise.resolve().then(work).catch(()=>{}).finally(()=>this.background.delete(p));this.background.add(p);}
  private assertCurrentCatalog(t:TaskRecord){if(t.input.allowedVendorIds.some(id=>!this.catalog.vendors.some(v=>v.vendorId===id))||t.plan&&t.plan.catalogVersion!==this.catalog.catalogVersion||t.snapshot.authorization&&t.snapshot.authorization.catalogVersion!==this.catalog.catalogVersion)throw new HttpError(409,'CATALOG_VERSION_MISMATCH','任务绑定的资源目录已变化，请新建任务。');}
  plan(t:TaskRecord){
    this.assertCurrentCatalog(t);
    if(t.snapshot.status!=='DRAFT')throw new HttpError(409,'PLAN_ALREADY_STARTED');
    t.snapshot.status='PLANNING';this.change(t,'plan.planning','仅从用户目标和可信目录生成资源计划。');
    this.launch(async()=>{
      try{const current=this.get(t.snapshot.taskId);if(current.snapshot.status!=='PLANNING')return;
        const plan=this.workflow.plan(this.taskInput(current));plan.planHash=hashResourcePlan(plan);
        current.plan=plan;current.snapshot.planId=plan.planId;current.snapshot.planHash=plan.planHash;current.snapshot.status='AWAITING_AUTHORIZATION';
        this.change(current,'plan.ready','资源计划已生成，等待用户冻结。','PLAN',plan.planId);
      }catch{const current=this.get(t.snapshot.taskId);current.snapshot.status='FAILED';this.change(current,'task.updated','资源计划生成失败。');}
    });
  }
  routes():TrustedRoute[]{return this.catalog.vendors.map(v=>({...v,method:'GET',url:this.options.resourceMode==='live'?v.source!.url:`sandbox://${v.vendorId}/${v.routeId}`}));}
  authorize(t:TaskRecord,planHash:string){
    this.assertCurrentCatalog(t);
    if(t.snapshot.status!=='AWAITING_AUTHORIZATION'||!t.plan)throw new HttpError(409,'PLAN_NOT_READY');
    if(t.plan.planHash!==planHash)throw new HttpError(409,'PLAN_HASH_MISMATCH');
    const authorization:Public.AuthorizationView={authorizationId:id('auth'),version:1,status:'ACTIVE',planHash,goalHash:t.plan.goalHash,catalogVersion:t.plan.catalogVersion,budgetAtomic:t.input.budgetAtomic,maxPaidCalls:t.input.maxPaidCalls,expiresAt:t.input.expiresAt,authorizedAt:this.now().toISOString(),revokedAt:null};
    t.plan.status='FROZEN';this.ledger.freezeAuthorization({taskId:t.snapshot.taskId,plan:t.plan,authorization,catalog:this.catalog,routes:this.routes()});
    t.snapshot.authorization=authorization;t.snapshot.status='READY';this.syncBudget(t);this.change(t,'authorization.frozen','授权已冻结，后续内容不能扩展商家、用途或预算。','AUTHORIZATION',authorization.authorizationId);
  }
  syncBudget(t:TaskRecord){if(t.snapshot.authorization)t.snapshot.budget=this.ledger.budget(t.snapshot.taskId);this.store.putTask(t);}
  run(t:TaskRecord,version:number){
    this.assertCurrentCatalog(t);
    if(t.snapshot.status!=='READY'||!t.snapshot.authorization||!t.plan)throw new HttpError(409,'TASK_NOT_READY');
    if(t.snapshot.authorization.status!=='ACTIVE'||t.snapshot.authorization.version!==version)throw new HttpError(409,'AUTHORIZATION_VERSION_MISMATCH');
    if(Date.parse(t.snapshot.authorization.expiresAt)<=this.now().getTime())throw new HttpError(409,'AUTHORIZATION_EXPIRED');
    t.snapshot.status='RUNNING';this.change(t,'run.started','开始读取外部资料；所有支付必须通过冻结计划和签名前检查。');
    const taskId=t.snapshot.taskId;
    const frozenPlanHash=t.plan.planHash;
    const isRunActive=()=>{if(this.closed)return false;const current=this.store.getTask(taskId);return !!current&&['RUNNING','PAUSED_REVIEW'].includes(current.snapshot.status)&&current.snapshot.authorization?.status==='ACTIVE'&&current.snapshot.authorization.version===version&&current.plan?.planHash===frozenPlanHash&&current.plan.catalogVersion===this.catalog.catalogVersion;};
    const boundary=new RunBoundary({taskId,goal:t.input.goal,planHash:t.plan.planHash,authorizationVersion:version,memoryVersion:this.memory.version,catalog:this.catalog,store:this.store});
    this.launch(async()=>{
      try{
        if(!isRunActive())return;
        const result=await this.runtime.run({task:this.taskInput(t),plan:t.plan!,authorizationVersion:version,scenarioId:t.scenario as 'normal',onEvidence:records=>{if(!isRunActive()){this.runtime.cancelTask(taskId);throw new Error('RUN_NO_LONGER_ACTIVE');}boundary.registerEvidence(records);},onIntent:i=>{if(!isRunActive()){this.runtime.cancelTask(taskId);return Promise.resolve({verdict:'BLOCK',reasonCodes:['AUTHORIZATION_REVOKED']});}boundary.checkIntent(i);return this.onIntent(i);},onEvent:e=>{
          if(!isRunActive()){this.runtime.cancelTask(taskId);return;}
          const current=this.get(taskId);if(e.type==='LESSON_PROMOTED')this.change(current,'lesson.promoted','已发布通过沙箱回放验证的防御经验。','LESSON',e.resourceId??taskId);
          else if(e.type==='AGENT_STEP'){const summary=this.safeAgentStep(e.summary);current.snapshot.summary=summary;this.change(current,'task.updated',summary);}
        }});
        if(!isRunActive()){this.runtime.cancelTask(taskId);return;}boundary.registerEvidence(result.evidence);
        this.complete(taskId,result);
      }catch{if(!isRunActive())return;const current=this.get(taskId);current.snapshot.status='FAILED';current.snapshot.summary='工作流失败；已签授权仍保留占额，未自动重试。';this.saveFailureResult(current);this.syncBudget(current);this.change(current,'task.updated',current.snapshot.summary);}
    });
  }
  complete(taskId:string,result:WorkflowResult){
    const current=this.get(taskId);if(current.snapshot.status==='CANCELLED'||current.snapshot.authorization?.status==='REVOKED')return;
    if(result.taskId!==taskId||result.planHash!==current.plan?.planHash)throw new Error('WORKFLOW_RESULT_BINDING_MISMATCH');
    if(result.publicResult)this.saveResult(current,result.publicResult,result);else if(this.options.resourceMode==='live')throw new Error('LIVE_RESULT_REQUIRED');
    this.syncBudget(current);
    current.snapshot.status=BigInt(current.snapshot.budget.outstandingAtomic)>0n?'AWAITING_SETTLEMENT':result.status==='COMPLETED'&&(!result.publicResult||result.publicResult.status==='COMPLETED')?'COMPLETED':'FAILED';
    current.snapshot.summary=(result.publicResult?.report??result.summary).slice(0,500);
    this.change(current,current.snapshot.status==='COMPLETED'?'task.completed':'task.updated',current.snapshot.summary);
  }
  private safeAgentStep(summary:string):string {
    const fallback=JSON.stringify({kind:'AGENT_STEP',status:'OBSERVED'});
    if(typeof summary!=='string'||summary.length>8192)return fallback;
    const started=/^(observe|worker|threat|consistency|curator|execute) started; real model \/ public data; no payment requested$/.exec(summary);
    if(started)return JSON.stringify({kind:'ROLE_TRACE',role:started[1],status:'STARTED'});
    let value:Record<string,unknown>;try{const parsed=JSON.parse(summary);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return fallback;value=parsed;}catch{return fallback;}
    const out:Record<string,unknown>={kind:value.kind};
    const isId=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_-]{2,63}$/.test(v);
    const number=(key:string,maximum:number)=>{const v=value[key];if(Number.isSafeInteger(v)&&(v as number)>=0&&(v as number)<=maximum)out[key]=v;};
    if(value.kind==='MODEL_CALL'){
      if(!['worker','threat','consistency','curator'].includes(String(value.role))||!['SUCCEEDED','FAILED'].includes(String(value.status)))return fallback;
      out.role=value.role;out.status=value.status;if(value.phase==='select'||value.phase==='report')out.phase=value.phase;
      if(typeof value.actualModel==='string'&&/^(deepseek|gpt|o[0-9]|claude|gemini|qwen|llama|mistral)[A-Za-z0-9._:/-]{0,120}$/i.test(value.actualModel))out.actualModel=value.actualModel;
      number('latencyMs',3_600_000);if(Number.isInteger(value.httpStatus)&&(value.httpStatus as number)>=100&&(value.httpStatus as number)<=599)out.httpStatus=value.httpStatus;
      if(['TIMEOUT','NETWORK','HTTP_AUTH','HTTP_BALANCE','HTTP_RATE_LIMIT','HTTP_REQUEST','HTTP_SERVER','HTTP_OTHER','INVALID_RESPONSE','INVALID_OUTPUT','OUTPUT_LIMIT','INPUT_INVALID'].includes(String(value.errorCategory)))out.errorCategory=value.errorCategory;
      if(value.usage&&typeof value.usage==='object'&&!Array.isArray(value.usage)){const usage:Record<string,number>={};for(const key of ['promptTokens','completionTokens','totalTokens','promptCacheHitTokens','promptCacheMissTokens','reasoningTokens']){const n=(value.usage as Record<string,unknown>)[key];if(Number.isSafeInteger(n)&&(n as number)>=0&&(n as number)<=1_000_000_000)usage[key]=n as number;}if(Object.keys(usage).length)out.usage=usage;}
    }else if(value.kind==='SOURCE_READ'){
      const vendor=this.catalog.vendors.find(v=>v.vendorId===value.vendorId);
      if(!vendor?.source||value.source!==vendor.source.url||!['SUCCEEDED','FAILED'].includes(String(value.status)))return fallback;
      out.status=value.status;out.vendorId=vendor.vendorId;out.source=vendor.source.url;if(isId(value.evidenceId))out.evidenceId=value.evidenceId;
      if(typeof value.observedAt==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.observedAt)&&Number.isFinite(Date.parse(value.observedAt)))out.observedAt=value.observedAt;
    }else if(value.kind==='REPORT_READY'){
      if(!isId(value.evidenceId)||!Array.isArray(value.sourceEvidenceIds)||value.sourceEvidenceIds.length>10||!value.sourceEvidenceIds.every(isId))return fallback;
      out.evidenceId=value.evidenceId;out.sourceEvidenceIds=value.sourceEvidenceIds;
    }else if(value.kind==='REAL_RUN'){
      if(!['SUCCEEDED','FAILED','BLOCKED'].includes(String(value.status))||typeof value.code!=='string'||!/^[A-Z][A-Z0-9_]{1,79}$/.test(value.code))return fallback;
      out.status=value.status;out.code=value.code;
    }else return fallback;
    let encoded=JSON.stringify(out);if(encoded.length>500){delete out.usage;encoded=JSON.stringify(out);}if(encoded.length>500){delete out.actualModel;delete out.sourceEvidenceIds;encoded=JSON.stringify(out);}return encoded.length<=500?encoded:fallback;
  }
  private saveResult(t:TaskRecord,result:Public.TaskResult,workflow?:WorkflowResult){
    assertSchema('TaskResult',result);this.assertCurrentCatalog(t);
    if(result.taskId!==t.snapshot.taskId||new Set(result.evidenceIds).size!==result.evidenceIds.length||new Set(result.sources.map(source=>source.evidenceId)).size!==result.sources.length)throw new Error('TASK_RESULT_BINDING_MISMATCH');
    const expectedMode=this.options.resourceMode==='live'?'LIVE_HTTP':'SANDBOX';
    const expectedStatus=workflow?.status==='COMPLETED'?'COMPLETED':workflow?.status==='BLOCKED'?'BLOCKED':'FAILED';
    if(result.dataMode!==expectedMode||result.paymentMode!=='MOCK'||workflow&&result.status!==expectedStatus)throw new Error('TASK_RESULT_MODE_MISMATCH');
    if(workflow&&JSON.stringify([...result.evidenceIds].sort())!==JSON.stringify(workflow.evidence.map(e=>e.evidenceId).sort()))throw new Error('TASK_RESULT_EVIDENCE_SET_MISMATCH');
    for(const evidenceId of result.evidenceIds){const evidence=this.store.get<Public.EvidenceSummary>('evidence',evidenceId,t.snapshot.taskId);if(!evidence||evidence.taskId!==t.snapshot.taskId)throw new Error('TASK_RESULT_EVIDENCE_NOT_FOUND');}
    for(const source of result.sources){
      const record=this.store.get<Public.EvidenceSummary>('evidence',source.evidenceId,t.snapshot.taskId);
      const planned=t.plan?.items.some(item=>{const vendor=this.catalog.vendors.find(v=>v.vendorId===item.vendorId);return vendor?.source?.url===source.url&&vendor.source.name===source.name;});
      if(!record||record.taskId!==t.snapshot.taskId||record.sourceKind!=='TOOL_RESPONSE'||record.contentHash!==source.contentHash||!result.evidenceIds.includes(source.evidenceId)||!planned)throw new Error('TASK_RESULT_SOURCE_REJECTED');
    }
    if(this.options.resourceMode==='live'){
      if(result.model.mode!=='LIVE_API'||result.learningMode!=='NO_ONLINE_LABELS'||result.paidCalls!==0)throw new Error('TASK_RESULT_LIVE_MODE_REQUIRED');
      if(result.status==='COMPLETED'&&(!result.sources.length||!result.model.diagnostics.some(d=>d.role==='worker'&&d.phase==='report'&&d.status==='SUCCEEDED'&&d.httpStatus===200)))throw new Error('TASK_RESULT_MODEL_SUCCESS_REQUIRED');
      if(result.status==='COMPLETED'){
        const citations=[...result.report.matchAll(/\[(\d+)\]/g)].map(match=>Number(match[1]));
        if(!citations.length||citations.some(index=>index<1||index>result.sources.length))throw new Error('TASK_RESULT_REPORT_CITATIONS_REQUIRED');
        const citedIds=new Set(citations.map(index=>result.sources[index-1]!.evidenceId));
        const records=new Map(result.evidenceIds.map(evidenceId=>[evidenceId,this.store.get<Public.EvidenceSummary>('evidence',evidenceId,t.snapshot.taskId)!]));
        const reportHash=digest(result.report),reportExcerpt=redact(result.report).slice(0,1200);
        const bound=[...records.values()].some(record=>{
          if(record.sourceKind!=='MODEL_OUTPUT'||record.contentHash!==reportHash||record.excerpt!==reportExcerpt)return false;
          // The model saw numbered source inputs in this order. A set equality
          // would accept a swapped public sources array with reversed [n] links.
          if(record.parentIds.length===0||record.parentIds.some((id,index)=>records.get(id)?.sourceKind!=='TOOL_RESPONSE'||result.sources[index]?.evidenceId!==id))return false;
          const seen=new Set<string>(),parents=[...record.parentIds];while(parents.length){const parent=parents.pop()!;if(seen.has(parent))continue;const evidence=records.get(parent);if(!evidence)return false;seen.add(parent);parents.push(...evidence.parentIds);}return [...citedIds].every(id=>seen.has(id));
        });
        if(!bound)throw new Error('TASK_RESULT_REPORT_EVIDENCE_REQUIRED');
      }
    }
    this.store.put('result',t.snapshot.taskId,t.snapshot.taskId,structuredClone(result));
  }
  private saveFailureResult(t:TaskRecord){
    const live=this.options.resourceMode==='live';const result:Public.TaskResult={schemaVersion:'0.2.0',taskId:t.snapshot.taskId,status:'FAILED',report:'任务未完成；本次没有可发布的完整报告，未自动重试或生成替代结果。',sources:[],evidenceIds:this.store.list<Public.EvidenceSummary>('evidence',t.snapshot.taskId).map(e=>e.evidenceId),model:{mode:this.runtime.providerMode==='OPENAI_COMPATIBLE_API'?'LIVE_API':'DETERMINISTIC_SANDBOX',diagnostics:[]},dataMode:live?'LIVE_HTTP':'SANDBOX',paymentMode:'MOCK',paidCalls:this.store.list<Public.PaymentView>('payment',t.snapshot.taskId).filter(p=>p.state==='SETTLED').length,learningMode:live?'NO_ONLINE_LABELS':'SANDBOX_ORACLE'};
    this.saveResult(t,result);
  }
  getTaskResult(t:TaskRecord):Public.TaskResult {const result=this.store.get<Public.TaskResult>('result',t.snapshot.taskId,t.snapshot.taskId);if(!result)throw new HttpError(409,'RESULT_NOT_READY');assertSchema('TaskResult',result);return result;}
  paymentIntent(i:ProcurementIntent):PaymentIntent{return {taskId:i.taskId,planItemId:i.planItemId,logicalPurchaseId:i.logicalPurchaseId,vendorId:i.vendorId,toolId:i.toolId,routeId:i.routeId,resourceKind:i.resourceKind,method:i.method,selectors:i.selectors,payTo:i.payTo,amountAtomic:i.amountAtomic,asset:this.catalog.asset};}
  async onIntent(i:ProcurementIntent):Promise<IntentResult>{
    if(this.closed)return {verdict:'BLOCK',reasonCodes:['SERVER_STOPPED']};
    // Live capabilities are free, read-only public sources. A cannot manufacture
    // a paid offer from a source response or create a simulated payment record.
    if(this.options.resourceMode==='live')return {verdict:'BLOCK',state:'REJECTED',reasonCodes:['FREE_SOURCE_HAS_NO_PAYMENT']};
    const t=this.get(i.taskId);if(t.snapshot.status==='CANCELLED'||t.snapshot.authorization?.status!=='ACTIVE')return {verdict:'BLOCK',reasonCodes:['AUTHORIZATION_REVOKED']};
    const intent=this.paymentIntent(i);let requestHash=sha256({intent}),offerHash=sha256({payTo:i.payTo,amount:i.amountAtomic});let gate:'PASS'|'BLOCK'='PASS',reason:string|undefined;
    try{const prepared=this.ledger.prepare(intent);requestHash=prepared.requestHash;offerHash=prepared.offerHash;}catch(e){gate='BLOCK';reason=e instanceof Error&&'code'in e?String(e.code):'FROZEN_PLAN_REJECTED';}
    const paymentId=id('pay'),decisionId=id('decision'),now=this.now().toISOString();
    const action=gate==='BLOCK'?'BLOCK':i.decision;
    const decision:Public.DecisionView={schemaVersion:'0.1.0',decisionId,taskId:i.taskId,paymentId,type:action,hardGate:gate,reasonCodes:reason?[reason]:i.reasonCodes,summary:gate==='BLOCK'?'确定性资金与计划检查拒绝此付款。':action==='BLOCK'?'安全角色拒绝不可信内容诱导。':action==='REVIEW'?'计划内付款需要用户复核；确认只作用于当前精确付款。':'付款符合冻结计划和风险检查。',requestHash,offerHash,evidenceIds:i.evidenceIds,planHash:t.plan!.planHash,authorizationVersion:t.snapshot.authorization!.version,policyVersion:'policy_v1',memoryVersion:i.memoryVersion,reviewers:i.reviewers.map(r=>({role:r.role,verdict:r.verdict,reasonCode:r.reasonCode,evidenceIds:r.evidenceIds})),expiresAt:new Date(Math.min(Date.parse(t.input.expiresAt),this.now().getTime()+(this.options.reviewTtlMs??300000))).toISOString()};
    const view:Public.PaymentView={schemaVersion:'0.1.0',paymentId,taskId:i.taskId,version:1,planItemId:i.planItemId,logicalPurchaseId:i.logicalPurchaseId,state:action==='BLOCK'?'REJECTED':'CREATED',executionMode:'MOCK',authorizationStatus:'NOT_CREATED',vendorId:i.vendorId,toolId:i.toolId,routeId:i.routeId,resourceKind:i.resourceKind,method:i.method,asset:this.catalog.asset,payTo:i.payTo,amountAtomic:i.amountAtomic,requestHash,offerHash,decision,receipt:{status:'NONE',transactionHash:null,mockReceiptId:null,checkedAt:null},createdAt:now,updatedAt:now};
    this.savePayment(view);
    if(action==='BLOCK')return {verdict:'BLOCK',state:'REJECTED',reasonCodes:decision.reasonCodes};
    if(action==='REVIEW'){
      const reviewId=id('review');const review:Public.ReviewView={schemaVersion:'0.1.0',reviewId,taskId:i.taskId,paymentId,version:1,etag:`"${reviewId}:v1"`,status:'PENDING',snapshotHash:sha256({requestHash,offerHash,planHash:t.plan!.planHash,authorizationVersion:decision.authorizationVersion,paymentId,expiresAt:decision.expiresAt}),requestHash,offerHash,planHash:t.plan!.planHash,authorizationVersion:decision.authorizationVersion,reasonCode:decision.reasonCodes[0]??'USER_REVIEW',summary:decision.summary,amountAtomic:i.amountAtomic,payTo:i.payTo,vendorId:i.vendorId,expiresAt:decision.expiresAt,createdAt:now,resolvedAt:null};
      this.store.put('review',reviewId,i.taskId,review);const current=this.get(i.taskId);current.snapshot.status='PAUSED_REVIEW';this.change(current,'review.required','等待用户确认当前精确付款。','REVIEW',reviewId);
      // Private pending intent persists for safe restart; never returned by HTTP.
      this.store.db.prepare('CREATE TABLE IF NOT EXISTS app_pending(review_id TEXT PRIMARY KEY,data TEXT NOT NULL)').run();
      this.store.db.prepare('INSERT OR REPLACE INTO app_pending(review_id,data) VALUES(?,?)').run(reviewId,JSON.stringify({intent:i,paymentId}));
      return new Promise(resolve=>this.pending.set(reviewId,{intent:i,paymentId,resolve}));
    }
    return this.execute(i,view);
  }
  savePayment(view:Public.PaymentView){assertSchema('PaymentView',view);this.store.put('payment',view.paymentId,view.taskId,view);const t=this.get(view.taskId);this.syncBudget(t);this.change(t,'payment.updated',`${view.decision.type} / ${view.state}`,'PAYMENT',view.paymentId);}
  async execute(i:ProcurementIntent,view:Public.PaymentView):Promise<IntentResult>{
    try{
      const intent=this.paymentIntent(i);const bound={action:'ALLOW' as const,taskId:i.taskId,requestHash:view.requestHash,offerHash:view.offerHash,authorizationVersion:view.decision.authorizationVersion,expiresAt:view.decision.expiresAt};
      let record:PaymentRecord;
      if(this.get(i.taskId).scenario==='unknown'){
        record=this.ledger.reserve(intent);const permit=this.ledger.beginSigning(record.paymentId);const metadata=await this.signer.signPermit(permit);this.ledger.markSigned(metadata);this.ledger.markDispatched(record.paymentId);record=this.ledger.markUnknown(record.paymentId,'SANDBOX_RESPONSE_LOST');
      }else record=await this.kernel.executeSandbox(intent,bound);
      this.applyRecord(view,record);this.savePayment(view);return {verdict:'ALLOW',state:view.state,receipt:view.receipt};
    }catch(e){
      const record=this.ledger.list(i.taskId).find(p=>p.logicalPurchaseId===i.logicalPurchaseId);
      if(record)this.applyRecord(view,record);else{view.state='REJECTED';view.decision.type='BLOCK';view.decision.reasonCodes=[e instanceof Error&&'code'in e?String(e.code):'PAYMENT_FAILED'];}
      this.savePayment(view);return {verdict:record?.state==='UNKNOWN'?'ALLOW':'BLOCK',state:view.state,receipt:view.receipt,reasonCodes:view.decision.reasonCodes};
    }
  }
  applyRecord(view:Public.PaymentView,record:PaymentRecord){view.version++;view.state=record.state;view.updatedAt=this.now().toISOString();view.authorizationStatus=record.nonce?'SIMULATED':'NOT_CREATED';view.receipt={status:record.state==='SETTLED'?'SIMULATED':record.state==='UNKNOWN'?'UNKNOWN':'NONE',transactionHash:null,mockReceiptId:record.state==='SETTLED'?`sim_${record.paymentId}`:null,checkedAt:this.now().toISOString()};}
  review(t:TaskRecord,reviewId:string):Public.ReviewView{const r=this.store.get<Public.ReviewView>('review',reviewId,t.snapshot.taskId);if(!r)throw new HttpError(404,'REVIEW_NOT_FOUND');return r;}
  resolveReview(t:TaskRecord,r:Public.ReviewView,choice:'APPROVE'|'REJECT',snapshotHash:string):HttpError|undefined{
    this.assertCurrentCatalog(t);
    if(r.status!=='PENDING')throw new HttpError(409,'REVIEW_NOT_PENDING');
    if(Date.parse(r.expiresAt)<=this.now().getTime()){
      this.finishReview(t,r,'EXPIRED');this.pending.get(r.reviewId)?.resolve?.({verdict:'BLOCK',reasonCodes:['REVIEW_EXPIRED']});this.pending.delete(r.reviewId);return new HttpError(409,'REVIEW_EXPIRED');
    }
    if(r.snapshotHash!==snapshotHash)throw new HttpError(409,'REVIEW_SNAPSHOT_MISMATCH');
    if(t.snapshot.authorization?.status!=='ACTIVE'||t.snapshot.authorization.version!==r.authorizationVersion||t.plan?.planHash!==r.planHash)throw new HttpError(409,'REVIEW_STALE');
    let pending=this.pending.get(r.reviewId);
    if(!pending){const row=this.store.db.prepare('SELECT data FROM app_pending WHERE review_id=?').get(r.reviewId) as {data:string}|undefined;if(row)pending=JSON.parse(row.data);}
    if(!pending)throw new HttpError(409,'REVIEW_INTENT_MISSING');
    const view=this.store.get<Public.PaymentView>('payment',r.paymentId,t.snapshot.taskId)!;
    if(view.decision.hardGate!=='PASS'||view.requestHash!==r.requestHash||view.offerHash!==r.offerHash)throw new HttpError(409,'REVIEW_STALE');
    this.ledger.prepare(this.paymentIntent(pending.intent));
    this.finishReview(t,r,choice==='APPROVE'?'APPROVED':'REJECTED');
    const continuation=pending;this.pending.delete(r.reviewId);
    if(choice==='APPROVE')this.launch(async()=>{const result=await this.execute(continuation.intent,view);if(continuation.resolve)continuation.resolve({...result,reviewResolution:'APPROVED'});else {const current=this.get(t.snapshot.taskId);this.syncBudget(current);current.snapshot.status=BigInt(current.snapshot.budget.outstandingAtomic)>0n?'AWAITING_SETTLEMENT':'COMPLETED';this.change(current,'task.completed','恢复的精确审批已执行，未重放整个任务。');}});
    else{view.state='REJECTED';view.updatedAt=this.now().toISOString();this.savePayment(view);continuation.resolve?.({verdict:'BLOCK',reasonCodes:['USER_REJECTED']});if(!continuation.resolve){t=this.get(t.snapshot.taskId);t.snapshot.status='COMPLETED';this.change(t,'task.completed','用户拒绝付款。');}}
  }
  finishReview(t:TaskRecord,r:Public.ReviewView,status:Public.ReviewView['status']){r.status=status;r.version++;r.etag=`"${r.reviewId}:v${r.version}"`;r.resolvedAt=this.now().toISOString();this.store.put('review',r.reviewId,t.snapshot.taskId,r);t.snapshot.status='RUNNING';this.change(t,status==='EXPIRED'?'review.expired':'review.resolved',`审批状态：${status}`,'REVIEW',r.reviewId);}
  revoke(t:TaskRecord,cancel:boolean){
    if(t.snapshot.authorization?.status==='ACTIVE'){this.ledger.revoke(t.snapshot.taskId);t.snapshot.authorization.status='REVOKED';t.snapshot.authorization.version++;t.snapshot.authorization.revokedAt=this.now().toISOString();}
    for(const r of this.store.list<Public.ReviewView>('review',t.snapshot.taskId).filter(r=>r.status==='PENDING')){r.status='CANCELLED';r.version++;r.etag=`"${r.reviewId}:v${r.version}"`;r.resolvedAt=this.now().toISOString();this.store.put('review',r.reviewId,t.snapshot.taskId,r);this.pending.get(r.reviewId)?.resolve?.({verdict:'BLOCK',reasonCodes:['AUTHORIZATION_REVOKED']});this.pending.delete(r.reviewId);}
    t.snapshot.status=cancel?'CANCELLED':'FAILED';t.snapshot.summary='已停止新签名；已有签名可在有效期内结算，占额仍保留。';this.syncBudget(t);this.change(t,cancel?'task.cancelled':'authorization.revoked',t.snapshot.summary);this.runtime.cancelTask(t.snapshot.taskId);
  }
  async close(){
    if(this.closed)return;this.closed=true;for(const p of this.pending.values())p.resolve?.({verdict:'BLOCK',reasonCodes:['SERVER_STOPPED']});this.pending.clear();
    for(const set of this.subscribers.values())for(const response of set)response.end();this.subscribers.clear();
    await this.runtime.close();await Promise.allSettled(this.background);await this.kernel.close();this.memory.close();this.store.close();
    if(this.temporaryMemoryDirectory){const target=resolve(this.temporaryMemoryDirectory);if(!target.startsWith(resolve(tmpdir())+sep)||!basename(target).startsWith('motion-memory-'))throw new Error('TEMP_CLEANUP_BOUNDARY');rmSync(target,{recursive:true,force:true});}
  }
}
