import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CreateTask, TaskSnapshot, ResourcePlan, EventEnvelope, PaymentView, ReviewView, EvidenceSummary, TaskResult } from './generated/contracts.js';
export interface TaskRecord { snapshot: TaskSnapshot; input: CreateTask; plan: ResourcePlan | null; scenario: string; owner: string }
export interface StoredResponse { status: number; schema: string; body: unknown; headers?: Record<string,string> }
export class AppStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive: true});
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS app_tasks(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS app_objects(kind TEXT NOT NULL, id TEXT NOT NULL, task_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS app_events(task_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(task_id,seq));
      CREATE TABLE IF NOT EXISTS app_idempotency(scope TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(scope,key));`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const v = fn(); this.db.exec('COMMIT'); return v; } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  getTask(id: string): TaskRecord | undefined { const r=this.db.prepare('SELECT data FROM app_tasks WHERE id=?').get(id) as {data:string}|undefined; return r && JSON.parse(r.data); }
  tasks(): TaskRecord[] { return (this.db.prepare('SELECT data FROM app_tasks').all() as {data:string}[]).map(r=>JSON.parse(r.data)); }
  putTask(task: TaskRecord) { this.db.prepare('INSERT OR REPLACE INTO app_tasks(id,data) VALUES(?,?)').run(task.snapshot.taskId,JSON.stringify(task)); }
  put(kind: 'payment'|'review'|'evidence'|'result', id: string, taskId: string, value: PaymentView|ReviewView|EvidenceSummary|TaskResult) { this.db.prepare('INSERT OR REPLACE INTO app_objects(kind,id,task_id,data) VALUES(?,?,?,?)').run(kind,id,taskId,JSON.stringify(value)); }
  get<T>(kind: string, id: string, taskId: string): T|undefined { const r=this.db.prepare('SELECT data FROM app_objects WHERE kind=? AND id=? AND task_id=?').get(kind,id,taskId) as {data:string}|undefined; return r && JSON.parse(r.data); }
  list<T>(kind: string, taskId: string): T[] { return (this.db.prepare('SELECT data FROM app_objects WHERE kind=? AND task_id=? ORDER BY rowid').all(kind,taskId) as {data:string}[]).map(r=>JSON.parse(r.data)); }
  addEvent(event: EventEnvelope, historyLimit: number) { this.db.prepare('INSERT INTO app_events(task_id,seq,data) VALUES(?,?,?)').run(event.taskId,event.seq,JSON.stringify(event)); this.db.prepare('DELETE FROM app_events WHERE task_id=? AND seq<=?').run(event.taskId,event.seq-historyLimit); }
  events(taskId: string, after: number): EventEnvelope[] { return (this.db.prepare('SELECT data FROM app_events WHERE task_id=? AND seq>? ORDER BY seq').all(taskId,after) as {data:string}[]).map(r=>JSON.parse(r.data)); }
  minSeq(taskId: string): number { return Number((this.db.prepare('SELECT MIN(seq) AS n FROM app_events WHERE task_id=?').get(taskId) as {n:number|null}).n ?? 0); }
  idempotency(scope: string,key: string): {fingerprint:string;response:StoredResponse}|undefined { const r=this.db.prepare('SELECT fingerprint,response FROM app_idempotency WHERE scope=? AND key=?').get(scope,key) as {fingerprint:string;response:string}|undefined; return r && {...r,response:JSON.parse(r.response)}; }
  remember(scope: string,key: string,fingerprint: string,response: StoredResponse) { this.db.prepare('INSERT INTO app_idempotency(scope,key,fingerprint,response) VALUES(?,?,?,?)').run(scope,key,fingerprint,JSON.stringify(response)); }
  close() { this.db.close(); }
}
