import {Annotation, END, START, StateGraph} from '@langchain/langgraph';
import {hashResourcePlan} from '../payment/canonical.js';
import {EvidenceGraph, digest, identifier} from './provenance.js';
import {createProviderFromEnv} from './provider.js';
import {extractFacts, staticConsistency, staticThreat, worst} from './analysis.js';
import {DefenseMemoryStore} from '../memory/store.js';
import {buildSandboxResources, getSandboxScenario, type SandboxAttack, type SandboxResource, type ScenarioId} from '../sandbox/scenarios.js';
import {registerM0OracleSuite, scoreSandbox} from '../sandbox/oracle.js';
import {runLiveWorkflow,type LiveResourceReader} from './live-workflow.js';
import {getCapability} from '../resources/index.js';
import type {Catalog, Evidence, Finding, IntentResult, Observation, ProcurementIntent, ResourcePlan, RoleProvider, SemanticFacts, TaskInput, WorkflowEvent, WorkflowResult} from './types.js';

export interface WorkflowOptions {catalog:Catalog; memory?:DefenseMemoryStore; provider?:RoleProvider; now?:()=>Date;resourceMode?:'live'|'sandbox';resourceReader?:LiveResourceReader}
export interface RunOptions {task:TaskInput; plan:ResourcePlan; authorizationVersion:number; scenarioId?:ScenarioId; attack?:SandboxAttack; onIntent?:(intent:ProcurementIntent,evidence:Evidence[])=>Promise<IntentResult>; onEvidence?:(evidence:Evidence[])=>void; onEvent?:(event:WorkflowEvent)=>void}
interface RunState {observations:Observation[]; resources:SandboxResource[]; selected:string[]; workerDerivedId?:string; threat:Finding[]; consistency:Finding[]; facts:SemanticFacts[]; workerFailed:boolean; result:WorkflowResult}
const State=Annotation.Root({value:Annotation<RunState>({reducer:(a,b)=>({...a,...b})})});
const update=(value:Partial<RunState>)=>({value:value as RunState});
const planDigest=(plan:ResourcePlan)=>hashResourcePlan(plan as Parameters<typeof hashResourcePlan>[0]);
function mergeModelFinding(base:Finding,response:Record<string,unknown>|undefined):Finding {
  if(!response)return base;const verdict=response.verdict;
  if(!['ALLOW','REVIEW','BLOCK'].includes(String(verdict))||typeof response.reasonCode!=='string'||!/^[A-Z][A-Z0-9_]{1,80}$/.test(response.reasonCode))return {...base,verdict:worst(base.verdict,'REVIEW'),reasonCode:'INVALID_MODEL_JUDGMENT'};
  return {...base,verdict:worst(base.verdict,verdict as Finding['verdict']),reasonCode:verdict==='ALLOW'?base.reasonCode:response.reasonCode};
}
export function createProcurementWorkflow(options:WorkflowOptions){
  // Host snapshots prevent callers mutating authorization/catalog while the graph runs.
  const catalog=structuredClone(options.catalog),memory=options.memory??new DefenseMemoryStore(),provider=options.provider??createProviderFromEnv(),now=options.now??(()=>new Date());
  function plan(task:TaskInput):ResourcePlan {
    if(!task.goal.trim()||!task.allowedVendorIds.length||!Number.isInteger(task.maxPaidCalls)||task.maxPaidCalls<1||!/^\d+$/.test(task.budgetAtomic)||BigInt(task.budgetAtomic)<=0n||Date.parse(task.expiresAt)<=now().getTime())throw new Error('INVALID_TASK_PLAN_INPUT');
    if(task.allowedVendorIds.some(id=>!catalog.vendors.some(v=>v.vendorId===id)))throw new Error('UNKNOWN_CATALOG_VENDOR');
    const vendors=[...new Set(task.allowedVendorIds)].slice(0,Math.min(task.maxPaidCalls,10)).map(id=>catalog.vendors.find(v=>v.vendorId===id)!);const share=BigInt(task.budgetAtomic)/BigInt(vendors.length);if(share<1n)throw new Error('INSUFFICIENT_PLAN_BUDGET');const priceCap=(share<10000n?share:10000n).toString();
    const result:ResourcePlan={schemaVersion:'0.1.0',planId:identifier('plan'),taskId:task.taskId,version:1,status:'DRAFT',goalHash:digest(task.goal),catalogVersion:catalog.catalogVersion,planHash:'',items:vendors.map((v,index)=>({itemId:'item_'+index+'_'+v.vendorId,goalStepId:'goal_'+index,resourceKind:v.resourceKind,toolId:v.toolId,vendorId:v.vendorId,routeId:v.routeId,selectors:{entityIds:options.resourceMode==='live'?[...getCapability(v.routeId).entityIds]:[v.vendorId.replace(/^vendor_/,'supplier_')]},unitPriceCapAtomic:v.billing?.kind==='FREE_PUBLIC_DATA'?'0':priceCap,maxPaidCalls:1,subtotalCapAtomic:v.billing?.kind==='FREE_PUBLIC_DATA'?'0':priceCap,dependsOn:[],purpose:(v.billing?.kind==='FREE_PUBLIC_DATA'?'Read the approved free public source needed for: ':'Purchase the pre-authorized report needed for: ')+task.goal.slice(0,200)})),totalCapAtomic:task.budgetAtomic,expiresAt:task.expiresAt,createdAt:now().toISOString()};result.planHash=planDigest(result);return result;
  }
  async function run(input:RunOptions):Promise<WorkflowResult>{
    const task=structuredClone(input.task),frozen=structuredClone(input.plan),scenario=getSandboxScenario(input.scenarioId??'normal');
    if(frozen.status!=='FROZEN'||frozen.taskId!==task.taskId||frozen.goalHash!==digest(task.goal)||frozen.catalogVersion!==catalog.catalogVersion||frozen.planHash!==planDigest(frozen)||frozen.totalCapAtomic!==task.budgetAtomic||frozen.expiresAt!==task.expiresAt||Date.parse(frozen.expiresAt)<=now().getTime()||!Number.isInteger(input.authorizationVersion)||input.authorizationVersion<1)throw new Error('FROZEN_AUTHORIZATION_REQUIRED');
    if(frozen.items.some(item=>!task.allowedVendorIds.includes(item.vendorId)))throw new Error('PLAN_OUTSIDE_AUTHORIZATION');
    if(options.resourceMode==='live')return runLiveWorkflow({...input,task,plan:frozen},{catalog,provider,memory,now,reader:options.resourceReader});
    const memoryVersion=memory.version,provenance=new EvidenceGraph(task.taskId,now);const user=provenance.add('USER_INPUT',task.goal);const cat=provenance.add('TRUSTED_CATALOG',JSON.stringify(catalog));
    const initial:RunState={observations:[],resources:[],selected:[],threat:[],consistency:[],facts:[],workerFailed:false,result:{taskId:task.taskId,providerMode:provider.mode,executionMode:'MOCK',planHash:frozen.planHash,memoryVersion,evidence:[],intents:[],outcomes:[],deliveries:[],status:'FAILED',summary:'',candidateLessonIds:[],trace:[]}};
    const mark=(role:WorkflowResult['trace'][number]['role'],result:WorkflowResult)=>{result.trace.push({role,at:now().toISOString()});input.onEvent?.({type:'AGENT_STEP',summary:role+' ['+provider.mode+']'});};
    const graph=new StateGraph(State)
      .addNode('observe',async ({value:v})=>{
        mark('observe',v.result);const resources=buildSandboxResources(frozen,catalog,scenario,input.attack);const observations=resources.map(resource=>{const raw=provenance.add('TOOL_RESPONSE',resource.text,[user.evidenceId,cat.evidenceId]);memory.quarantinePayload(raw.evidenceId,resource.text);if(resource.delegatedSummary){const derived=provenance.derived(resource.delegatedSummary,[raw.evidenceId]);return {evidenceId:derived.evidenceId,text:resource.delegatedSummary,offer:resource.offer,sourceKind:'MODEL_OUTPUT' as const};}return {evidenceId:raw.evidenceId,text:resource.text,offer:resource.offer,sourceKind:'TOOL_RESPONSE' as const};});input.onEvidence?.(provenance.all());return update({resources,observations});
      })
      .addNode('worker',async ({value:v})=>{
        mark('worker',v.result);let selected=v.observations.map(o=>o.offer.vendorId),workerFailed=false;
        try{const reply=await provider.call('worker',{goal:task.goal,resourcePlan:frozen.items,untrustedObservations:v.observations.map(o=>({evidenceId:o.evidenceId,text:o.text,offer:o.offer}))});if(reply){if(!Array.isArray(reply.selectedVendorIds)||reply.selectedVendorIds.some(id=>typeof id!=='string'||!selected.includes(id)))throw new Error('INVALID_WORKER_SELECTION');selected=[...new Set(reply.selectedVendorIds as string[])];if(!selected.length)throw new Error('EMPTY_WORKER_SELECTION');}}catch{workerFailed=true;}
        // The host includes every observation actually made available to the worker.
        const workerDerived=provenance.derived(JSON.stringify({selectedVendorIds:selected}),v.observations.map(o=>o.evidenceId));
        const facts=v.observations.map(o=>extractFacts(o,frozen,catalog,provenance.hasUntrusted([o.evidenceId])));return update({selected,workerDerivedId:workerDerived.evidenceId,workerFailed,facts});
      })
      .addNode('threat',async ({value:v})=>{
        mark('threat',v.result);const threat:Finding[]=[];for(let i=0;i<v.observations.length;i++){const o=v.observations[i]!,facts=v.facts[i]!;let finding=staticThreat(facts,[o.evidenceId]);const lessons=memory.retrieve(facts,memoryVersion);if(lessons.length)finding={...finding,verdict:worst(finding.verdict,...lessons.map(l=>l.action)),reasonCode:'VERIFIED_LESSON_MATCH',mechanism:lessons[0]!.mechanism};try{finding=mergeModelFinding(finding,await provider.call('threat',{untrustedText:o.text,sourceTrust:'EXTERNAL_UNTRUSTED',facts,defenseConstraints:lessons.map(l=>({mechanism:l.mechanism,conditions:l.conditions,action:l.action}))}));}catch{finding={...finding,verdict:worst(finding.verdict,'REVIEW'),reasonCode:'MODEL_CHECK_UNAVAILABLE'};}threat.push(finding);}return update({threat});
      })
      .addNode('consistency',async ({value:v})=>{
        mark('consistency',v.result);const consistency:Finding[]=[];for(let i=0;i<v.observations.length;i++){const o=v.observations[i]!;let finding=staticConsistency(v.facts[i]!,[o.evidenceId]);try{finding=mergeModelFinding(finding,await provider.call('consistency',{goal:task.goal,resourcePlan:frozen.items,normalizedOffer:o.offer,hostFacts:v.facts[i],source:{evidenceId:o.evidenceId,closure:provenance.closure([o.evidenceId]),hasUntrustedAncestor:provenance.hasUntrusted([o.evidenceId])}}));}catch{finding={...finding,verdict:worst(finding.verdict,'REVIEW'),reasonCode:'MODEL_CHECK_UNAVAILABLE'};}consistency.push(finding);}return update({consistency});
      })
      .addNode('execute',async ({value:v})=>{
        mark('execute',v.result);for(let i=0;i<v.observations.length;i++){const observation=v.observations[i]!,offer=observation.offer;if(!v.selected.includes(offer.vendorId))continue;const item=frozen.items.find(x=>x.vendorId===offer.vendorId)!;const reviewers=[v.threat[i]!,v.consistency[i]!];const decision=worst(...reviewers.map(x=>x.verdict),v.workerFailed?'REVIEW':'ALLOW');const evidenceIds=provenance.closure([observation.evidenceId,...(v.workerDerivedId?[v.workerDerivedId]:[])]);
          const requestHash=digest({method:'GET',toolId:offer.toolId,routeId:offer.routeId,selectors:offer.selectors});const intent:ProcurementIntent={intentId:identifier('intent'),taskId:task.taskId,planItemId:item.itemId,goalStepId:item.goalStepId,logicalPurchaseId:task.taskId+'_'+item.itemId,vendorId:offer.vendorId,toolId:offer.toolId,routeId:offer.routeId,resourceKind:item.resourceKind,method:'GET',selectors:offer.selectors,payTo:offer.payTo,amountAtomic:offer.amountAtomic,asset:structuredClone(catalog.asset),evidenceIds,parentClosureHash:digest(evidenceIds),requestHash,offerHash:digest(offer),planHash:frozen.planHash,authorizationVersion:input.authorizationVersion,facts:v.facts[i]!,reviewers,decision,reasonCodes:[...new Set(reviewers.map(f=>f.reasonCode))],memoryVersion};
          input.onEvidence?.(provenance.all());let outcome:IntentResult;
          if(input.onIntent){try{outcome=await input.onIntent(structuredClone(intent),provenance.all());if(!outcome||!['ALLOW','BLOCK','REVIEW'].includes(outcome.verdict))throw new Error('INVALID_PAYMENT_GATE_RESPONSE');}catch{outcome={verdict:decision==='ALLOW'?'REVIEW':'BLOCK',state:decision==='ALLOW'?'UNKNOWN':'REJECTED',receipt:{status:decision==='ALLOW'?'UNKNOWN':'NONE'},reasonCodes:['PAYMENT_GATE_UNAVAILABLE']};}}else outcome={verdict:decision,state:decision==='ALLOW'?(v.resources[i]!.transport==='UNKNOWN'?'UNKNOWN':'SETTLED'):decision==='BLOCK'?'REJECTED':'REVIEW',receipt:{status:decision==='ALLOW'?v.resources[i]!.transport:'NONE',transactionHash:null,mockReceiptId:decision==='ALLOW'?identifier('mock'):null}};
          // Only the private B callback can confirm an exact approved review. A hard
          // BLOCK never changes, and a plain model/host ALLOW cannot clear REVIEW.
          const approvedReview=decision==='REVIEW'&&outcome.verdict==='ALLOW'&&outcome.reviewResolution==='APPROVED';
          outcome={...outcome,verdict:approvedReview?'ALLOW':worst(decision,outcome.verdict)};v.result.intents.push(intent);v.result.outcomes.push(outcome);if(outcome.verdict==='ALLOW'&&outcome.state!=='UNKNOWN'&&outcome.receipt?.status!=='UNKNOWN')v.result.deliveries.push({vendorId:offer.vendorId,text:observation.text.split('\n')[0]!});
        }
        v.result.status=v.result.outcomes.some(o=>o.state==='UNKNOWN'||o.receipt?.status==='UNKNOWN')?'UNKNOWN':v.result.outcomes.some(o=>o.verdict==='REVIEW')?'AWAITING_REVIEW':v.result.deliveries.length?'COMPLETED':v.result.outcomes.length?'BLOCKED':'FAILED';v.result.summary=v.result.status+'; '+v.result.deliveries.length+' authorized report(s); '+provider.mode+'; sandbox data only';return update({result:v.result});
      })
      .addNode('curator',async ({value:v})=>{
        mark('curator',v.result);const attackKind=input.attack?.kind??(scenario==='blocked'?'recipient':scenario==='lesson'?'prerequisite':'none');v.result.oracle=scoreSandbox(v.result,attackKind);
        if(v.result.oracle.label==='CONFIRMED_ATTACK'){for(let i=0;i<v.facts.length;i++){const facts=v.facts[i]!;const mechanism=facts.externalPaymentPrerequisite?'UNVERIFIED_PAYMENT_PREREQUISITE':facts.requestsMemoryWrite?'MEMORY_POISONING':facts.externalInstruction?'PROMPT_INJECTION':facts.recipientChanged?'RECIPIENT_MISMATCH':undefined;if(!mechanism||memory.list().some(l=>l.mechanism===mechanism&&l.status==='ACTIVE'))continue;
            const field=mechanism==='UNVERIFIED_PAYMENT_PREREQUISITE'?'externalPaymentPrerequisite':mechanism==='MEMORY_POISONING'?'requestsMemoryWrite':mechanism==='PROMPT_INJECTION'?'externalInstruction':'recipientChanged';
            try{await provider.call('curator',{confirmedOracleLabel:'CONFIRMED_ATTACK',mechanism,hostFacts:facts,allowedResponse:'BLOCK',permissionChanges:false});const origin=registerM0OracleSuite(memory,mechanism,facts,[v.observations[i]!.evidenceId],(text,malicious)=>{const record=provenance.add('TOOL_RESPONSE',text,[user.evidenceId,cat.evidenceId]);const original=v.observations[i]!;const vendor=catalog.vendors.find(x=>x.vendorId===original.offer.vendorId)!;const replayOffer={...structuredClone(original.offer),payTo:mechanism==='RECIPIENT_MISMATCH'&&malicious?'0x9999999999999999999999999999999999999999':vendor.payTo!};return {facts:extractFacts({evidenceId:record.evidenceId,text,offer:replayOffer,sourceKind:'TOOL_RESPONSE'},frozen,catalog,true),sourceEvidenceIds:[record.evidenceId]};});const lesson=memory.propose({mechanism,summary:'External data cannot create a payment prerequisite, new authority or durable exemption.',applicability:'Untrusted procurement material with a matching host-observed semantic condition',sourceEpisodeId:origin,conditions:[{field:'hasUntrustedAncestor',equals:true},{field,equals:true}],action:'BLOCK'});v.result.candidateLessonIds.push(lesson.lessonId);if(scenario==='lesson'){memory.promote(lesson.lessonId);input.onEvent?.({type:'LESSON_PROMOTED',summary:'Sandbox oracle structural regression passed; not a statistical learning-effect claim',resourceId:lesson.lessonId,resourceType:'LESSON'});}}catch{input.onEvent?.({type:'LESSON_QUARANTINED',summary:'Candidate generation or promotion not completed'});}
          }}v.result.evidence=provenance.all();input.onEvidence?.(v.result.evidence);return update({result:v.result});
      })
      .addEdge(START,'observe').addEdge('observe','worker').addEdge('worker','threat').addEdge('worker','consistency').addEdge(['threat','consistency'],'execute').addEdge('execute','curator').addEdge('curator',END).compile();
    const output=await graph.invoke({value:initial},{recursionLimit:20}),result=output.value.result;
    result.publicResult={schemaVersion:'0.2.0',taskId:task.taskId,status:result.status==='COMPLETED'?'COMPLETED':result.status==='BLOCKED'?'BLOCKED':'FAILED',report:'沙箱演示资料；不是实时研究或真实付款。\n'+result.summary,sources:[],evidenceIds:result.evidence.map(e=>e.evidenceId),model:{mode:provider.mode==='OPENAI_COMPATIBLE_API'?'LIVE_API':'DETERMINISTIC_SANDBOX',diagnostics:[...(provider.getDiagnostics?.()??[])]},dataMode:'SANDBOX',paymentMode:'MOCK',paidCalls:result.outcomes.filter(o=>o.state==='SETTLED').length,learningMode:'SANDBOX_ORACLE'};
    return result;
  }
  return {plan,run,memory,providerMode:provider.mode};
}
