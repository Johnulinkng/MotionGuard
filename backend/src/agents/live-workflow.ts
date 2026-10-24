import {getRealResource, type ResourceReadResult} from '../resources/index.js';
import {ModelProviderError} from './provider.js';
import {EvidenceGraph} from './provenance.js';
import {staticThreat,worst} from './analysis.js';
import type {RunOptions} from './workflow.js';
import type {Catalog,ProviderCallDiagnostic,RoleProvider,SemanticFacts,WorkflowResult} from './types.js';
import type {DefenseMemoryStore} from '../memory/store.js';

export type LiveResourceReader=typeof getRealResource;
async function allOrFail<T>(promises:Promise<T>[]):Promise<T[]>{const settled=await Promise.allSettled(promises);const failed=settled.find(x=>x.status==='rejected');if(failed?.status==='rejected')throw failed.reason;return settled.map(x=>(x as PromiseFulfilledResult<T>).value);}
/** Free reads never construct an offer or enter the payment callback. */
export async function runLiveWorkflow(input:RunOptions,options:{catalog:Catalog;provider:RoleProvider;memory:DefenseMemoryStore;now:()=>Date;reader?:LiveResourceReader}):Promise<WorkflowResult>{
  const {catalog,provider,memory,now}=options,task=input.task,plan=input.plan;
  if(provider.mode!=='OPENAI_COMPATIBLE_API')throw new Error('REAL_MODEL_CONFIGURATION_REQUIRED');
  const evidence=new EvidenceGraph(task.taskId,now),user=evidence.add('USER_INPUT',task.goal),directory=evidence.add('TRUSTED_CATALOG',JSON.stringify(catalog));
  const diagnostics:ProviderCallDiagnostic[]=[],sources:{evidenceId:string;url:string;name:string;observedAt:string;contentHash:string}[]=[];
  const unsubscribe=provider.onDiagnostic?.(diagnostic=>{diagnostics.push(diagnostic);const {role,phase,status,actualModel,latencyMs,httpStatus,errorCategory,usage}=diagnostic;input.onEvent?.({type:'AGENT_STEP',summary:JSON.stringify({kind:'MODEL_CALL',role,phase,status,actualModel,latencyMs,httpStatus,errorCategory,usage})});});
  const result:WorkflowResult={taskId:task.taskId,providerMode:provider.mode,executionMode:'MOCK',planHash:plan.planHash,memoryVersion:memory.version,evidence:[],intents:[],outcomes:[],deliveries:[],status:'FAILED',summary:'',candidateLessonIds:[],trace:[]};
  const mark=(role:WorkflowResult['trace'][number]['role'])=>{result.trace.push({role,at:now().toISOString()});input.onEvent?.({type:'AGENT_STEP',summary:role+' started; real model / public data; no payment requested'});};
  const publish=()=>{result.evidence=evidence.all();input.onEvidence?.(result.evidence);};
  let report='';
  try{
    mark('observe');
    const observations=await allOrFail(plan.items.map(async item=>{
      const vendor=catalog.vendors.find(v=>v.vendorId===item.vendorId);
      if(!vendor||vendor.billing?.kind!=='FREE_PUBLIC_DATA'||vendor.payTo!==null||!vendor.source)throw new Error('REAL_RESOURCE_CONFIGURATION_REQUIRED');
      const read:ResourceReadResult=await (options.reader??getRealResource)({plan,planItemId:item.itemId,catalogVersion:catalog.catalogVersion,routeId:item.routeId,selectors:item.selectors});
      if(read.transport!=='LIVE_HTTP'||read.billing.requiresPayment||read.billing.amountAtomic!=='0'||read.vendorId!==vendor.vendorId||read.source.url!==vendor.source.url)throw new Error('REAL_RESOURCE_BINDING_MISMATCH');
      const raw=evidence.add('TOOL_RESPONSE',read.text,[user.evidenceId,directory.evidenceId]);
      memory.quarantinePayload(raw.evidenceId,read.text);
      sources.push({evidenceId:raw.evidenceId,url:read.source.url,name:read.source.name,observedAt:read.observedAt,contentHash:raw.contentHash});
      publish();input.onEvent?.({type:'AGENT_STEP',summary:JSON.stringify({kind:'SOURCE_READ',status:'SUCCEEDED',vendorId:vendor.vendorId,evidenceId:raw.evidenceId,source:read.source.url,observedAt:read.observedAt})});
      return {item,vendor,read,evidenceId:raw.evidenceId};
    }));
    mark('worker');
    const selection=await provider.call('worker',{phase:'select',goal:task.goal,resourcePlan:plan.items,availableResources:observations.map(o=>({vendorId:o.vendor.vendorId,evidenceId:o.evidenceId,description:o.vendor.description}))});
    if(!selection||!Array.isArray(selection.selectedVendorIds)||!selection.selectedVendorIds.length||selection.selectedVendorIds.some(id=>typeof id!=='string'||!observations.some(o=>o.vendor.vendorId===id)))throw new Error('INVALID_WORKER_SELECTION');
    const selectedIds=selection.selectedVendorIds as string[],selected=observations.filter(o=>selectedIds.includes(o.vendor.vendorId));
    // [n] is an index into the public sources array, independent of HTTP completion order.
    const citationOrder=[...selected,...observations.filter(o=>!selectedIds.includes(o.vendor.vendorId))].map(o=>o.evidenceId);
    sources.sort((a,b)=>citationOrder.indexOf(a.evidenceId)-citationOrder.indexOf(b.evidenceId));
    evidence.derived(JSON.stringify(selection),[user.evidenceId,directory.evidenceId]);
    const checks=await allOrFail(observations.map(async o=>{
      const text=o.read.text.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g,'');
      const facts:SemanticFacts={externalInstruction:/(ignore.{0,40}(?:previous|prior|instructions|budget)|system\s*(?:update|override)|忽略.{0,30}(?:指令|预算|规则)|绕过.{0,20}(?:审核|限制))/is.test(text),externalPaymentPrerequisite:/(?:must|requires?|first|先|必须|需要|需).{0,70}(?:pay|fee|付款|支付|费用)/is.test(text),recipientChanged:false,amountExceeded:false,descriptorChanged:false,purposeOutsidePlan:false,requestsMemoryWrite:/(remember permanently|always trust|exempt from review|以后.{0,30}(?:免审|信任)|永久.{0,20}(?:记住|授权|信任))/is.test(text),hasUntrustedAncestor:true,duplicateRequest:false,needsReview:false};
      const lessons=memory.retrieve(facts,result.memoryVersion),base=staticThreat(facts,[o.evidenceId]);
      const [threat,consistency]=await allOrFail([
        (async()=>{mark('threat');return provider.call('threat',{goal:task.goal,untrustedText:o.read.text,sourceTrust:'EXTERNAL_UNTRUSTED',facts,defenseConstraints:lessons.map(l=>({mechanism:l.mechanism,conditions:l.conditions,action:l.action})),paymentRequested:false});})(),
        // This role reads only the frozen user goal, plan and trusted capability.
        // A worker's paraphrase of external text is never evidence of necessity.
        (async()=>{mark('consistency');return provider.call('consistency',{goal:task.goal,resourcePlan:plan.items,plannedItem:o.item,trustedCapability:{name:o.vendor.name,description:o.vendor.description,source:o.vendor.source,billing:o.vendor.billing},hostFacts:{matchesFrozenPlan:true,paymentRequested:false},instruction:'Check whether this trusted capability can contribute evidence to the authorized goal. Missing historical data should be reported as a limit, never invented.'});})(),
      ]);
      const verdict=(v:Record<string,unknown>|undefined)=>{if(!v||!['ALLOW','REVIEW','BLOCK'].includes(String(v.verdict)))throw new Error('INVALID_MODEL_JUDGMENT');return v.verdict as 'ALLOW'|'REVIEW'|'BLOCK';};
      const decision=worst(base.verdict,...lessons.map(l=>l.action),verdict(threat),verdict(consistency));
      evidence.derived(JSON.stringify({role:'THREAT',verdict:threat!.verdict,reasonCode:threat!.reasonCode,staticVerdict:base.verdict}),[o.evidenceId]);
      evidence.derived(JSON.stringify({role:'CONSISTENCY',verdict:consistency!.verdict,reasonCode:consistency!.reasonCode}),[user.evidenceId,directory.evidenceId]);
      return {decision,reasons:[base.reasonCode,String(threat!.reasonCode),String(consistency!.reasonCode)]};
    }));
    publish();
    if(checks.some(c=>c.decision!=='ALLOW')){
      result.status='BLOCKED';report='资料未通过安全或任务一致性检查，本次未生成报告、未请求付款。原因：'+[...new Set(checks.flatMap(c=>c.reasons))].join(', ');
    }else{
      mark('worker');
      const provided=selected.map((o,index)=>({number:index+1,evidenceId:o.evidenceId,name:o.read.source.name,url:o.read.source.url,observedAt:o.read.observedAt,sourceTimestamp:o.read.sourceTimestamp,untrustedData:o.read.text}));
      const reply=await provider.call('worker',{phase:'report',goal:task.goal,asOf:now().toISOString(),sources:provided,requirements:'Answer the actual goal using only the supplied source facts. Cite [1], [2] etc. Separate Base Sepolia testnet from Base mainnet and Ethereum mainnet. A point-in-time quote or TVL cannot establish a trend. Describe unsupported parts explicitly. No payment occurred. Never give a successful fixed supplier report.'});
      if(!reply||typeof reply.report!=='string'||!reply.report.trim()||reply.report.length>8000||!Array.isArray(reply.sourceEvidenceIds)||reply.sourceEvidenceIds.length<1||reply.sourceEvidenceIds.some(id=>typeof id!=='string'||!provided.some(s=>s.evidenceId===id)))throw new Error('INVALID_REPORT_EVIDENCE');
      const refs=[...reply.report.matchAll(/\[(\d+)\]/g)].map(m=>Number(m[1]));
      if(!refs.length||refs.some(n=>n<1||n>provided.length))throw new Error('INVALID_REPORT_CITATIONS');
      const citedIds=[...new Set(refs.map(n=>provided[n-1]!.evidenceId))].sort(),declaredIds=[...new Set(reply.sourceEvidenceIds as string[])].sort();
      if(JSON.stringify(citedIds)!==JSON.stringify(declaredIds))throw new Error('REPORT_CITATION_EVIDENCE_MISMATCH');
      report=reply.report;const output=evidence.derived(report,selected.map(o=>o.evidenceId));
      result.deliveries=selected.map(o=>({vendorId:o.vendor.vendorId,text:report}));
      result.status='COMPLETED';input.onEvent?.({type:'AGENT_STEP',summary:JSON.stringify({kind:'REPORT_READY',evidenceId:output.evidenceId,sourceEvidenceIds:reply.sourceEvidenceIds})});
    }
  }catch(error){
    result.status='FAILED';const code=error instanceof ModelProviderError?`MODEL_${error.category}`:error instanceof Error&&/^[A-Z][A-Z0-9_]{1,79}$/.test(error.message)?error.message:'REAL_WORKFLOW_FAILED';
    report=`任务未完成：${code}。已获取的资料与模型诊断保留；没有生成替代沙箱结果，也没有请求付款。`;
    input.onEvent?.({type:'AGENT_STEP',summary:JSON.stringify({kind:'REAL_RUN',status:'FAILED',code})});
  }finally{unsubscribe?.();}
  publish();
  result.summary=report.slice(0,500);
  result.publicResult={schemaVersion:'0.2.0',taskId:task.taskId,status:result.status as 'COMPLETED'|'BLOCKED'|'FAILED',report,sources,evidenceIds:result.evidence.map(e=>e.evidenceId),model:{mode:'LIVE_API',diagnostics},dataMode:'LIVE_HTTP',paymentMode:'MOCK',paidCalls:0,learningMode:'NO_ONLINE_LABELS'};
  // Live feedback has no trusted attack label. No oracle scoring or promotion.
  result.oracle={label:'UNCONFIRMED',completed:result.status==='COMPLETED',unsafeActions:0};
  return result;
}
