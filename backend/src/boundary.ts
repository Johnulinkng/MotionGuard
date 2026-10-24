import {assertSchema} from './contracts.js';
import {canonical, digest, redact} from './agents/provenance.js';
import type {Catalog, Evidence, ProcurementIntent, SemanticFacts, Verdict} from './agents/types.js';
import type {AppStore} from './storage.js';

const ID=/^[A-Za-z][A-Za-z0-9_-]{2,63}$/;
const HASH=/^sha256:[a-f0-9]{64}$/;
const ATOMIC=/^(0|[1-9][0-9]{0,29})$/;
const RANK:Record<Verdict,number>={ALLOW:0,REVIEW:1,BLOCK:2};
const FACTS=['externalInstruction','externalPaymentPrerequisite','recipientChanged','amountExceeded','descriptorChanged','purposeOutsidePlan','requestsMemoryWrite','hasUntrustedAncestor','duplicateRequest','needsReview'] as const;
const INTENT_KEYS=['intentId','taskId','planItemId','goalStepId','logicalPurchaseId','vendorId','toolId','routeId','resourceKind','method','selectors','payTo','amountAtomic','asset','evidenceIds','parentClosureHash','requestHash','offerHash','planHash','authorizationVersion','facts','reviewers','decision','reasonCodes','memoryVersion'];
export class RunBoundaryError extends Error {readonly code='RUNTIME_BOUNDARY_REJECTED';constructor(){super('RUNTIME_BOUNDARY_REJECTED');}}
function requireThat(condition:unknown):asserts condition {if(!condition)throw new RunBoundaryError();}
function object(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function closed(value:unknown,keys:readonly string[]):asserts value is Record<string,unknown>{requireThat(object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)));}
function ids(value:unknown,maximum=256):asserts value is string[]{requireThat(Array.isArray(value)&&value.length>0&&value.length<=maximum&&value.every(id=>typeof id==='string'&&ID.test(id))&&new Set(value).size===value.length);}
function verdict(value:unknown):asserts value is Verdict {requireThat(typeof value==='string'&&Object.hasOwn(RANK,value));}
function code(value:unknown){requireThat(typeof value==='string'&&/^[A-Z][A-Z0-9_]{1,79}$/.test(value));}
export interface RunBoundaryOptions {taskId:string;goal:string;planHash:string;authorizationVersion:number;memoryVersion:string;catalog:Catalog;store:AppStore}

/** Domain B checks A's messages before any callback can reserve money. IPC is not authority. */
export class RunBoundary {
  private readonly options:RunBoundaryOptions;
  constructor(options:RunBoundaryOptions){this.options={...options,catalog:structuredClone(options.catalog)};requireThat(ID.test(options.taskId)&&HASH.test(options.planHash)&&Number.isSafeInteger(options.authorizationVersion)&&options.authorizationVersion>0);}
  private stored(id:string):Evidence|undefined {
    const row=this.options.store.db.prepare("SELECT task_id,data FROM app_objects WHERE kind='evidence' AND id=?").get(id) as {task_id:string;data:string}|undefined;
    if(!row)return undefined;requireThat(row.task_id===this.options.taskId);const record=JSON.parse(row.data) as Evidence;requireThat(record.taskId===this.options.taskId&&record.evidenceId===id);return record;
  }
  private closure(ids:string[],get:(id:string)=>Evidence|undefined):string[] {
    const seen=new Set<string>(),visiting=new Set<string>();
    const visit=(id:string)=>{requireThat(!visiting.has(id));if(seen.has(id))return;const record=get(id);requireThat(record&&record.taskId===this.options.taskId);visiting.add(id);record.parentIds.forEach(visit);visiting.delete(id);seen.add(id);};
    ids.forEach(visit);return [...seen].sort();
  }
  registerEvidence(records:unknown):void {
    requireThat(Array.isArray(records)&&records.length>0&&records.length<=256);
    const incoming=new Map<string,Evidence>();
    for(const value of records){
      try{assertSchema('EvidenceSummary',value);}catch{throw new RunBoundaryError();}
      const record=structuredClone(value) as Evidence;requireThat(record.taskId===this.options.taskId&&record.sourceKind!=='HOST_CHECK');
      const duplicate=incoming.get(record.evidenceId),existing=this.stored(record.evidenceId);
      requireThat((!duplicate||canonical(duplicate)===canonical(record))&&(!existing||canonical(existing)===canonical(record)));
      incoming.set(record.evidenceId,record);
    }
    const get=(id:string)=>incoming.get(id)??this.stored(id);
    for(const record of incoming.values()){
      const parents=this.closure(record.parentIds,get);requireThat(record.parentClosureHash===digest(parents));
      const untrusted=parents.some(id=>get(id)!.trust==='EXTERNAL_UNTRUSTED');
      if(record.sourceKind==='USER_INPUT')requireThat(record.trust==='USER_TRUSTED'&&parents.length===0&&record.contentHash===digest(this.options.goal)&&record.excerpt===redact(this.options.goal).slice(0,1200));
      else if(record.sourceKind==='TRUSTED_CATALOG'){const text=JSON.stringify(this.options.catalog);requireThat(record.trust==='HOST_OBSERVED'&&parents.length===0&&record.contentHash===digest(text)&&record.excerpt===redact(text).slice(0,1200));}
      else {
        requireThat(parents.length>0&&parents.some(id=>get(id)!.sourceKind==='USER_INPUT')&&parents.some(id=>get(id)!.sourceKind==='TRUSTED_CATALOG'));
        requireThat(record.trust===(record.sourceKind==='TOOL_RESPONSE'||untrusted?'EXTERNAL_UNTRUSTED':'MODEL_DERIVED'));
      }
    }
    // Validate the entire batch before any record becomes visible. Existing IDs are immutable.
    this.options.store.transaction(()=>{for(const record of incoming.values()){const existing=this.stored(record.evidenceId);requireThat(!existing||canonical(existing)===canonical(record));if(!existing)this.options.store.put('evidence',record.evidenceId,this.options.taskId,record);}});
  }
  checkIntent(value:unknown):void {
    closed(value,INTENT_KEYS);const intent=value as unknown as ProcurementIntent;
    requireThat(intent.taskId===this.options.taskId&&intent.planHash===this.options.planHash&&intent.authorizationVersion===this.options.authorizationVersion&&intent.memoryVersion===this.options.memoryVersion);
    for(const field of ['intentId','taskId','planItemId','goalStepId','logicalPurchaseId','vendorId','toolId','routeId'] as const)requireThat(typeof intent[field]==='string'&&ID.test(intent[field]));
    requireThat(['DOCUMENT','MARKET_DATA','ANALYSIS'].includes(intent.resourceKind)&&intent.method==='GET'&&typeof intent.payTo==='string'&&/^0x[\da-f]{40}$/i.test(intent.payTo)&&typeof intent.amountAtomic==='string'&&ATOMIC.test(intent.amountAtomic)&&BigInt(intent.amountAtomic)>0n);
    requireThat(object(intent.selectors)&&Object.keys(intent.selectors).every(key=>key==='entityIds'));
    if(intent.selectors.entityIds!==undefined)ids(intent.selectors.entityIds,10);
    requireThat(canonical(intent.asset)===canonical(this.options.catalog.asset));
    for(const field of ['parentClosureHash','requestHash','offerHash','planHash'] as const)requireThat(typeof intent[field]==='string'&&HASH.test(intent[field]));
    ids(intent.evidenceIds);const closure=this.closure(intent.evidenceIds,id=>this.stored(id));requireThat(canonical(closure)===canonical([...intent.evidenceIds].sort())&&digest(closure)===intent.parentClosureHash);
    const evidence=closure.map(id=>this.stored(id)!);requireThat(evidence.some(record=>record.sourceKind==='MODEL_OUTPUT')&&evidence.some(record=>record.sourceKind==='TOOL_RESPONSE'));
    closed(intent.facts,FACTS);requireThat(FACTS.every(field=>typeof intent.facts[field]==='boolean'));requireThat(intent.facts.hasUntrustedAncestor===evidence.some(record=>record.trust==='EXTERNAL_UNTRUSTED'));
    requireThat(Array.isArray(intent.reviewers)&&intent.reviewers.length===2&&intent.reviewers.every(object)&&new Set(intent.reviewers.map(item=>item.role)).size===2);
    verdict(intent.decision);
    for(const finding of intent.reviewers){
      closed(finding,['role','verdict','reasonCode','evidenceIds','mechanism']);requireThat(['THREAT','CONSISTENCY'].includes(finding.role));verdict(finding.verdict);code(finding.reasonCode);ids(finding.evidenceIds);requireThat(finding.evidenceIds.every(id=>closure.includes(id))&&typeof finding.mechanism==='string'&&finding.mechanism.length>0&&finding.mechanism.length<=200);requireThat(RANK[intent.decision]>=RANK[finding.verdict]);
    }
    requireThat(Array.isArray(intent.reasonCodes)&&intent.reasonCodes.length>0&&intent.reasonCodes.length<=20);intent.reasonCodes.forEach(code);
    // These untrusted facts can strengthen a result, never grant a permission.
    const facts=intent.facts as SemanticFacts;
    if(facts.externalInstruction||facts.requestsMemoryWrite||facts.recipientChanged||facts.amountExceeded||facts.descriptorChanged||facts.purposeOutsidePlan)requireThat(intent.decision==='BLOCK');
    if(facts.externalPaymentPrerequisite||facts.needsReview)requireThat(RANK[intent.decision]>=RANK.REVIEW);
    const consumed=this.options.store.list<Evidence>('evidence',this.options.taskId).filter(record=>record.sourceKind==='TOOL_RESPONSE');
    requireThat(consumed.every(record=>closure.includes(record.evidenceId)));
  }
}
