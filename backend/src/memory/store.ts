import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {createCipheriv, createHmac, randomBytes} from 'node:crypto';
import {digest, identifier} from '../agents/provenance.js';
import type {SemanticFacts, Verdict} from '../agents/types.js';

export const FACT_FIELDS = ['externalInstruction','externalPaymentPrerequisite','recipientChanged','amountExceeded','descriptorChanged','purposeOutsidePlan','requestsMemoryWrite','hasUntrustedAncestor','duplicateRequest','needsReview'] as const;
export interface LessonCondition {field:keyof SemanticFacts; equals:boolean}
export interface PromotionView {promotionId:string; originReplayPassed:boolean; variantPassed:number; benignPassed:number; regressionPassed:boolean; permissionsUnchanged:boolean; publishedAt:string|null}
export interface LessonView {schemaVersion:'0.1.0'; lessonId:string; version:number; status:'QUARANTINED'|'ACTIVE'|'REVOKED'; mechanism:string; summary:string; applicability:string; sourceEvidenceIds:string[]; memoryVersion:string; promotion:PromotionView}
export interface DefenseLesson extends LessonView {conditions:LessonCondition[]; action:'BLOCK'|'REVIEW'}
export interface OracleEpisode {episodeId:string; mechanism:string; kind:'ORIGIN'|'VARIANT'|'BENIGN'|'REGRESSION'; facts:SemanticFacts; malicious:boolean; baselineVerdict:Verdict; sourceEvidenceIds:string[]; templateId:string}
export interface CandidateInput {mechanism:string; summary:string; applicability:string; sourceEpisodeId:string; conditions:LessonCondition[]; action:'BLOCK'|'REVIEW'}
export interface PromotionReport {lessonId:string; passed:boolean; checks:{episodeId:string; kind:string; expectedMalicious:boolean; matched:boolean; passed:boolean}[]; permissionsUnchanged:boolean; datasetHash:string; createdAt:string}

export function matchesLesson(lesson:Pick<DefenseLesson,'conditions'>, facts:SemanticFacts):boolean{return lesson.conditions.every(c=>facts[c.field]===c.equals);}
function validCandidate(input:CandidateInput):boolean{return ['BLOCK','REVIEW'].includes(input.action)&&input.conditions.length>0&&input.conditions.length<=8&&input.conditions.every(c=>FACT_FIELDS.includes(c.field as any)&&typeof c.equals==='boolean')&&input.conditions.some(c=>c.field==='hasUntrustedAncestor'&&c.equals)&&input.summary.length<=600&&input.applicability.length<=600&&input.mechanism.length<=200;}
function view(lesson:DefenseLesson):LessonView {const {conditions:_c,action:_a,...publicView}=lesson;return structuredClone(publicView);}
/** Private host capability, never expose this store or oracle recorder as an agent tool. */
export class DefenseMemoryStore {
  private db:DatabaseSync; private oracleKey:string; private payloadKey=randomBytes(32);
  constructor(path=':memory:'){
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS memory_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS lessons(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS oracle_episodes(id TEXT PRIMARY KEY,body TEXT NOT NULL,attestation TEXT NOT NULL); CREATE TABLE IF NOT EXISTS memory_packages(version TEXT PRIMARY KEY,lesson_ids TEXT NOT NULL); CREATE TABLE IF NOT EXISTS promotion_reports(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS quarantined_payloads(id TEXT PRIMARY KEY,ciphertext TEXT NOT NULL);`);
    const existing=this.db.prepare('SELECT value FROM memory_meta WHERE key=?').get('oracle_key') as any;this.oracleKey=existing?.value??randomBytes(32).toString('hex');
    this.db.prepare('INSERT OR IGNORE INTO memory_meta VALUES(?,?)').run('oracle_key',this.oracleKey);this.db.prepare('INSERT OR IGNORE INTO memory_meta VALUES(?,?)').run('version','memory_v0');this.db.prepare('INSERT OR IGNORE INTO memory_packages VALUES(?,?)').run('memory_v0','[]');
  }
  get version():string {return (this.db.prepare('SELECT value FROM memory_meta WHERE key=?').get('version') as any).value;}
  close(){this.db.close();}
  private sign(episode:OracleEpisode){return createHmac('sha256',this.oracleKey).update(JSON.stringify(episode)).digest('hex');}
  /** Only the sandbox oracle receives this closure. All provider contexts exclude it. */
  createOracleRecorder(){return (episode:OracleEpisode)=>{if(!episode.episodeId||!episode.templateId||!episode.sourceEvidenceIds.length)throw new Error('INVALID_ORACLE_EVIDENCE');const body=JSON.stringify(episode);const old=this.db.prepare('SELECT body FROM oracle_episodes WHERE id=?').get(episode.episodeId) as any;if(old&&old.body!==body)throw new Error('ORACLE_EPISODE_IMMUTABLE');this.db.prepare('INSERT OR IGNORE INTO oracle_episodes VALUES(?,?,?)').run(episode.episodeId,body,this.sign(episode));};}
  quarantinePayload(evidenceId:string,payload:string){const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',this.payloadKey,iv);const encrypted=Buffer.concat([cipher.update(payload,'utf8'),cipher.final()]);this.db.prepare('INSERT OR IGNORE INTO quarantined_payloads VALUES(?,?)').run(evidenceId,Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64'));}
  private episodes():OracleEpisode[]{return (this.db.prepare('SELECT body,attestation FROM oracle_episodes').all() as any[]).map(row=>{const episode=JSON.parse(row.body) as OracleEpisode;if(this.sign(episode)!==row.attestation)throw new Error('ORACLE_ATTESTATION_INVALID');return episode;});}
  private lesson(id:string):DefenseLesson|undefined{const row=this.db.prepare('SELECT body FROM lessons WHERE id=?').get(id) as any;return row?JSON.parse(row.body):undefined;}
  list():LessonView[]{return (this.db.prepare('SELECT body FROM lessons ORDER BY id').all() as any[]).map(row=>view(JSON.parse(row.body)));}
  get(id:string):LessonView|undefined{const lesson=this.lesson(id);return lesson?view(lesson):undefined;}
  propose(input:CandidateInput):DefenseLesson {
    if(!validCandidate(input))throw new Error('UNSAFE_LESSON_SCHEMA');const origin=this.episodes().find(e=>e.episodeId===input.sourceEpisodeId&&e.kind==='ORIGIN'&&e.malicious&&e.mechanism===input.mechanism);if(!origin)throw new Error('ORACLE_CONFIRMATION_REQUIRED');
    const lesson:DefenseLesson={schemaVersion:'0.1.0',lessonId:identifier('lesson'),version:1,status:'QUARANTINED',mechanism:input.mechanism,summary:input.summary,applicability:input.applicability,sourceEvidenceIds:origin.sourceEvidenceIds,memoryVersion:this.version,conditions:structuredClone(input.conditions),action:input.action,promotion:{promotionId:identifier('promotion'),originReplayPassed:false,variantPassed:0,benignPassed:0,regressionPassed:false,permissionsUnchanged:true,publishedAt:null}};
    this.save(lesson);return structuredClone(lesson);
  }
  private save(lesson:DefenseLesson){this.db.prepare('INSERT INTO lessons VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(lesson.lessonId,JSON.stringify(lesson));}
  promotionReport(id:string):PromotionReport|undefined {const row=this.db.prepare('SELECT body FROM promotion_reports WHERE id=?').get(id) as any;return row?JSON.parse(row.body):undefined;}
  promote(id:string):LessonView {
    const lesson=this.lesson(id);if(!lesson||lesson.status!=='QUARANTINED')throw new Error('LESSON_NOT_QUARANTINED');const cases=this.episodes().filter(e=>e.mechanism===lesson.mechanism);
    const checks=cases.map(e=>{const matched=matchesLesson(lesson,e.facts);const noRegression=e.kind==='REGRESSION'?(!matched||e.malicious):true;return {episodeId:e.episodeId,kind:e.kind,expectedMalicious:e.malicious,matched,passed:e.kind==='REGRESSION'?noRegression:matched===e.malicious};});
    const count=(kind:string)=>checks.filter(c=>c.kind===kind&&c.passed).length;
    const passed=validCandidate({...lesson,sourceEpisodeId:'host'})&&count('ORIGIN')>=1&&count('VARIANT')>=2&&count('BENIGN')>=2&&count('REGRESSION')>=1&&checks.every(c=>c.passed)&&new Set(cases.filter(e=>e.kind==='VARIANT').map(e=>e.templateId)).size>=2&&new Set(cases.filter(e=>e.kind==='BENIGN').map(e=>e.templateId)).size>=2;
    const report:PromotionReport={lessonId:id,passed,checks,permissionsUnchanged:true,datasetHash:digest(cases),createdAt:new Date().toISOString()};this.db.prepare('INSERT OR REPLACE INTO promotion_reports VALUES(?,?)').run(id,JSON.stringify(report));
    if(!passed)throw new Error('PROMOTION_GATE_FAILED');
    this.db.exec('BEGIN IMMEDIATE');try{lesson.status='ACTIVE';const version=this.nextVersion();lesson.memoryVersion=version;lesson.promotion={promotionId:lesson.promotion.promotionId,originReplayPassed:count('ORIGIN')>=1,variantPassed:count('VARIANT'),benignPassed:count('BENIGN'),regressionPassed:count('REGRESSION')>=1,permissionsUnchanged:true,publishedAt:report.createdAt};this.save(lesson);const active=this.list().filter(l=>l.status==='ACTIVE').map(l=>l.lessonId);this.db.prepare('INSERT INTO memory_packages VALUES(?,?)').run(version,JSON.stringify(active));this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}return view(lesson);
  }
  private nextVersion(){const version='memory_v'+(Number(this.version.replace('memory_v',''))+1);this.db.prepare('UPDATE memory_meta SET value=? WHERE key=?').run(version,'version');return version;}
  retrieve(facts:SemanticFacts,version=this.version):DefenseLesson[]{const row=this.db.prepare('SELECT lesson_ids FROM memory_packages WHERE version=?').get(version) as any;if(!row)throw new Error('UNKNOWN_MEMORY_VERSION');return (JSON.parse(row.lesson_ids) as string[]).map(id=>this.lesson(id)!).filter(l=>l&&matchesLesson(l,facts)).sort((a,b)=>b.conditions.length-a.conditions.length).slice(0,3).map(l=>structuredClone(l));}
  rollback(targetVersion:string):string {const row=this.db.prepare('SELECT lesson_ids FROM memory_packages WHERE version=?').get(targetVersion) as any;if(!row)throw new Error('UNKNOWN_MEMORY_VERSION');const target=new Set<string>(JSON.parse(row.lesson_ids));this.db.exec('BEGIN IMMEDIATE');try{const version=this.nextVersion();for(const item of this.list()){const lesson=this.lesson(item.lessonId)!;lesson.status=target.has(lesson.lessonId)?'ACTIVE':lesson.status==='ACTIVE'?'REVOKED':lesson.status;lesson.memoryVersion=version;this.save(lesson);}this.db.prepare('INSERT INTO memory_packages VALUES(?,?)').run(version,row.lesson_ids);this.db.exec('COMMIT');return version;}catch(error){this.db.exec('ROLLBACK');throw error;}}
}
