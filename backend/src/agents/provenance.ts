import {createHash, randomUUID} from 'node:crypto';
import type {Evidence} from './types.js';
export function canonical(value:unknown):string { if(value===null||typeof value!=='object') return JSON.stringify(value); if(Array.isArray(value))return '['+value.map(canonical).join(',')+']'; return '{'+Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}'; }
export const digest=(value:unknown)=>'sha256:'+createHash('sha256').update(canonical(value)).digest('hex');
export const identifier=(prefix:string)=>prefix+'_'+randomUUID().replaceAll('-','').slice(0,24);
export function redact(text:string):string {return text.replace(/\bBearer\s+[^\s"<>]+/gi,'Bearer [REDACTED]').replace(/\bsk-[\w-]{8,}/g,'[REDACTED]').replace(/(?:private[_ ]?key|api[_ ]?key)\s*[:=]\s*[^\s,;]+/gi,'secret=[REDACTED]');}
/** Host-only provenance registry. Model supplied parents/trust are never accepted. */
export class EvidenceGraph {
  private records=new Map<string,Evidence>(); private raw=new Map<string,string>();
  constructor(readonly taskId:string, private now:()=>Date=()=>new Date()){}
  add(kind:Evidence['sourceKind'], text:string, parents:string[]=[]):Evidence {
    const closure=this.closure(parents); const inherited=closure.some(x=>this.records.get(x)!.trust==='EXTERNAL_UNTRUSTED');
    const trust:Evidence['trust']=kind==='USER_INPUT'?'USER_TRUSTED':kind==='TOOL_RESPONSE'||inherited?'EXTERNAL_UNTRUSTED':kind==='MODEL_OUTPUT'?'MODEL_DERIVED':'HOST_OBSERVED';
    const record:Evidence={schemaVersion:'0.1.0',evidenceId:identifier('evidence'),taskId:this.taskId,sourceKind:kind,trust,parentIds:[...new Set(parents)],parentClosureHash:digest(closure),contentHash:digest(text),excerpt:redact(text).slice(0,1200),recordedAt:this.now().toISOString()};
    this.records.set(record.evidenceId,record);this.raw.set(record.evidenceId,text);return structuredClone(record);
  }
  closure(ids:string[]):string[]{const seen=new Set<string>();const visit=(id:string)=>{if(seen.has(id))return;const node=this.records.get(id);if(!node)throw new Error('UNKNOWN_EVIDENCE');seen.add(id);node.parentIds.forEach(visit);};ids.forEach(visit);return [...seen].sort();}
  derived(text:string, actualReadIds:string[]):Evidence {return this.add('MODEL_OUTPUT',text,actualReadIds);}
  read(id:string):string {if(!this.raw.has(id))throw new Error('UNKNOWN_EVIDENCE');return this.raw.get(id)!;}
  all():Evidence[]{return structuredClone([...this.records.values()]);}
  hasUntrusted(ids:string[]):boolean{return this.closure(ids).some(id=>this.records.get(id)!.trust==='EXTERNAL_UNTRUSTED');}
}
