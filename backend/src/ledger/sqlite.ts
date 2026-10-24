import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomic, canonicalJson, sha256, utcSeconds } from '../payment/canonical.js';
import { immutableCopy, preparePayment, validateFrozenAuthorization } from '../payment/policy.js';
import { PaymentError, type AuthorizationCandidate, type Budget, type DispatchCommit, type ExecutionMode, type FrozenAuthorizationInput, type PaymentIntent, type PaymentRecord, type SignedMetadata, type SigningPermit, type SandboxSettlementProof, type VerifiedTestnetSettlement } from '../payment/types.js';

type Row = { data: string; stage: string | null; permit_id: string | null };
const LIVE = new Set(['RESERVED','SIGNED','DISPATCHED','UNKNOWN','SETTLED']);
export interface LedgerOptions { path: string; executionMode?: ExecutionMode; now?: () => number }

/** Domain B owns this file. Amounts are TEXT; bounded BigInt accounting happens under BEGIN IMMEDIATE. */
export class SqliteLedger {
  readonly db: DatabaseSync; readonly executionMode: ExecutionMode;
  private readonly now: () => number;
  constructor(options: LedgerOptions) {
    if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true });
    this.db = new DatabaseSync(options.path); this.executionMode = options.executionMode ?? 'MOCK';
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS mg_grants(task_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, data TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mg_payments(payment_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, logical_id TEXT NOT NULL, intent_hash TEXT NOT NULL, data TEXT NOT NULL, stage TEXT, permit_id TEXT, UNIQUE(task_id,logical_id));
      CREATE INDEX IF NOT EXISTS mg_payments_task ON mg_payments(task_id);
      CREATE TABLE IF NOT EXISTS mg_permits(payment_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mg_testnet_candidates(payment_id TEXT PRIMARY KEY, transaction_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mg_sandbox_nonces(asset TEXT NOT NULL, sender TEXT NOT NULL, nonce TEXT NOT NULL, PRIMARY KEY(asset,sender,nonce));
      CREATE TABLE IF NOT EXISTS mg_sandbox_balances(account TEXT NOT NULL, asset TEXT NOT NULL, amount TEXT NOT NULL, PRIMARY KEY(account,asset));`);
  }
  close(): void { this.db.close(); }
  nowSeconds(): number { return this.now(); }
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result=fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private at(): string { return new Date(this.now() * 1000).toISOString(); }
  freezeAuthorization(input: FrozenAuthorizationInput): void {
    const copy=immutableCopy(input); validateFrozenAuthorization(copy,this.now()); const fingerprint=sha256(copy);
    this.tx(() => {
      const existing=this.db.prepare('SELECT fingerprint FROM mg_grants WHERE task_id=?').get(copy.taskId) as {fingerprint:string}|undefined;
      if (existing) { if (existing.fingerprint !== fingerprint) throw new PaymentError('AUTHORIZATION_IMMUTABLE'); return; }
      this.db.prepare('INSERT INTO mg_grants(task_id,fingerprint,data,version) VALUES(?,?,?,?)').run(copy.taskId,fingerprint,canonicalJson(copy),copy.authorization.version);
    });
  }
  getAuthorization(taskId: string): FrozenAuthorizationInput {
    const row=this.db.prepare('SELECT data,revoked,version FROM mg_grants WHERE task_id=?').get(taskId) as {data:string;revoked:number;version:number}|undefined;
    if (!row) throw new PaymentError('AUTHORIZATION_NOT_FOUND');
    const input=JSON.parse(row.data) as FrozenAuthorizationInput;
    input.authorization.version=row.version;
    if (row.revoked) input.authorization.status='REVOKED';
    return input;
  }
  prepare(intent: PaymentIntent) { return preparePayment(this.getAuthorization(intent.taskId),intent); }
  private active(taskId: string): FrozenAuthorizationInput {
    const input=this.getAuthorization(taskId);
    if (input.authorization.status !== 'ACTIVE') throw new PaymentError('AUTHORIZATION_REVOKED');
    if (utcSeconds(input.authorization.expiresAt) <= this.now() || utcSeconds(input.plan.expiresAt) <= this.now()) throw new PaymentError('AUTHORIZATION_EXPIRED');
    return input;
  }
  list(taskId: string): PaymentRecord[] {
    return (this.db.prepare('SELECT data FROM mg_payments WHERE task_id=? ORDER BY rowid').all(taskId) as {data:string}[]).map(r=>JSON.parse(r.data));
  }
  get(paymentId: string): PaymentRecord {
    const row=this.db.prepare('SELECT data FROM mg_payments WHERE payment_id=?').get(paymentId) as {data:string}|undefined;
    if (!row) throw new PaymentError('PAYMENT_NOT_FOUND'); return JSON.parse(row.data) as PaymentRecord;
  }
  budget(taskId: string): Budget {
    const input=this.getAuthorization(taskId); const sums={settled:0n,reserved:0n,outstanding:0n};
    for (const p of this.list(taskId)) {
      if (p.state==='SETTLED') sums.settled+=atomic(p.amountAtomic);
      else if (p.state==='RESERVED') sums.reserved+=atomic(p.amountAtomic);
      else if (['SIGNED','DISPATCHED','UNKNOWN'].includes(p.state)) sums.outstanding+=atomic(p.amountAtomic);
    }
    const limit=atomic(input.authorization.budgetAtomic); const available=limit-sums.settled-sums.reserved-sums.outstanding;
    if (available < 0n) throw new PaymentError('LEDGER_INVARIANT_VIOLATION');
    return {schemaVersion:'0.1.0',taskId,asset:input.catalog.asset,limitAtomic:limit.toString(),settledAtomic:sums.settled.toString(),reservedAtomic:sums.reserved.toString(),outstandingAtomic:sums.outstanding.toString(),availableAtomic:available.toString(),version:input.authorization.version};
  }
  reserve(intent: PaymentIntent): PaymentRecord {
    return this.tx(()=>{
      const input=this.active(intent.taskId); const prepared=preparePayment(input,intent);
      const existing=this.db.prepare('SELECT data,intent_hash FROM mg_payments WHERE task_id=? AND logical_id=?').get(intent.taskId,intent.logicalPurchaseId) as {data:string;intent_hash:string}|undefined;
      if (existing) { if(existing.intent_hash!==prepared.intentHash) throw new PaymentError('IDEMPOTENCY_CONFLICT'); return JSON.parse(existing.data); }
      const all=this.list(intent.taskId).filter(p=>LIVE.has(p.state)); const item=input.plan.items.find(i=>i.itemId===intent.planItemId)!;
      if (all.length>=input.authorization.maxPaidCalls) throw new PaymentError('CALL_CAP_EXCEEDED');
      const itemPayments=all.filter(p=>p.planItemId===item.itemId);
      if(itemPayments.length>=item.maxPaidCalls) throw new PaymentError('RESOURCE_CALL_CAP_EXCEEDED');
      if(itemPayments.reduce((s,p)=>s+atomic(p.amountAtomic),0n)+atomic(intent.amountAtomic)>atomic(item.subtotalCapAtomic)) throw new PaymentError('RESOURCE_BUDGET_EXCEEDED');
      if(atomic(this.budget(intent.taskId).availableAtomic)<atomic(intent.amountAtomic)) throw new PaymentError('BUDGET_EXCEEDED');
      if(item.dependsOn.some(d=>!all.some(p=>p.planItemId===d && p.state==='SETTLED'))) throw new PaymentError('DEPENDENCY_NOT_SETTLED');
      const record:PaymentRecord={...prepared,paymentId:`pay_${randomUUID().replaceAll('-','')}`,state:'RESERVED',executionMode:this.executionMode,version:1,authorizationVersion:input.authorization.version,nonce:null,validBefore:null,signerAddress:null,authorizationHash:null,transactionHash:null,reasonCode:null,createdAt:this.at(),updatedAt:this.at()};
      this.db.prepare('INSERT INTO mg_payments(payment_id,task_id,logical_id,intent_hash,data) VALUES(?,?,?,?,?)').run(record.paymentId,record.taskId,record.logicalPurchaseId,record.intentHash,canonicalJson(record)); return record;
    });
  }
  private put(record: PaymentRecord, stage: string|null=null, permitId: string|null=null): PaymentRecord {
    record.version++; record.updatedAt=this.at();
    this.db.prepare('UPDATE mg_payments SET data=?,stage=?,permit_id=? WHERE payment_id=?').run(canonicalJson(record),stage,permitId,record.paymentId); return record;
  }
  beginSigning(paymentId: string, candidate?: AuthorizationCandidate): SigningPermit {
    return this.tx(()=>{
      const record=this.get(paymentId); const grant=this.active(record.taskId);
      if(record.state!=='RESERVED') throw new PaymentError('PAYMENT_NOT_RESERVED');
      const locked=this.db.prepare("SELECT payment_id FROM mg_payments WHERE task_id=? AND stage='SIGNING'").get(record.taskId);
      if(locked) throw new PaymentError('SIGNING_IN_PROGRESS');
      const limit=Math.min(this.now()+record.maxTimeoutSeconds,utcSeconds(grant.authorization.expiresAt),utcSeconds(grant.plan.expiresAt));
      if(candidate&&(!/^0x[\da-f]{64}$/i.test(candidate.nonce)||!Number.isSafeInteger(candidate.validBefore)||!Number.isSafeInteger(candidate.validAfter)||candidate.validAfter<0||candidate.validAfter>=this.now()||candidate.validBefore>limit))throw new PaymentError('INVALID_AUTHORIZATION_CANDIDATE');
      record.nonce=candidate?.nonce??`0x${randomBytes(32).toString('hex')}`;
      record.validBefore=candidate?.validBefore??limit;
      if(record.validBefore<=this.now()) throw new PaymentError('AUTHORIZATION_EXPIRED');
      const permitId=`permit_${randomUUID().replaceAll('-','')}`; this.put(record,'SIGNING',permitId);
      const permit:SigningPermit={permitId,paymentId,taskId:record.taskId,authorizationVersion:record.authorizationVersion,requestHash:record.requestHash,offerHash:record.offerHash,asset:record.asset,payTo:record.payTo as `0x${string}`,amountAtomic:record.amountAtomic,nonce:record.nonce,validAfter:candidate?.validAfter??Math.max(0,this.now()-1),validBefore:record.validBefore,executionMode:record.executionMode};
      this.db.prepare('INSERT INTO mg_permits(payment_id,data) VALUES(?,?)').run(paymentId,canonicalJson(permit));
      return permit;
    });
  }
  markSigned(metadata: SignedMetadata): PaymentRecord {
    return this.tx(()=>{
      const row=this.db.prepare('SELECT data,stage,permit_id FROM mg_payments WHERE payment_id=?').get(metadata.paymentId) as Row|undefined;
      if(!row || row.stage!=='SIGNING' || row.permit_id!==metadata.permitId) throw new PaymentError('SIGNING_PERMIT_MISMATCH');
      const record=JSON.parse(row.data) as PaymentRecord;
      if(record.nonce!==metadata.nonce || record.validBefore!==metadata.validBefore||!/^0x[\da-f]{40}$/i.test(metadata.signerAddress)||!/^0x[\da-f]{64}$/i.test(metadata.authorizationHash)) throw new PaymentError('SIGNATURE_METADATA_MISMATCH');
      record.state='SIGNED'; record.signerAddress=metadata.signerAddress;record.authorizationHash=metadata.authorizationHash;
      return this.put(record,'SIGNED',metadata.permitId);
    });
  }
  markDispatched(paymentId: string): DispatchCommit {
    return this.tx(()=>{
      const row=this.db.prepare('SELECT data,stage,permit_id FROM mg_payments WHERE payment_id=?').get(paymentId) as Row|undefined;
      if(!row) throw new PaymentError('PAYMENT_NOT_FOUND'); const record=JSON.parse(row.data) as PaymentRecord;
      if(record.state!=='SIGNED' || row.stage!=='SIGNED' || !row.permit_id || !record.signerAddress || !record.nonce || !record.authorizationHash || record.validBefore===null) throw new PaymentError('PAYMENT_NOT_SIGNED');
      // Revoke may win after the signed acknowledgment but before dispatch commitment.
      this.active(record.taskId);
      if(record.validBefore<=this.now())throw new PaymentError('AUTHORIZATION_EXPIRED');
      // This durable write must finish before any request carrying the signature leaves C.
      record.state='DISPATCHED'; this.put(record,'DISPATCHED',row.permit_id);
      return {paymentId,permitId:row.permit_id,nonce:record.nonce,validBefore:record.validBefore,signerAddress:record.signerAddress,authorizationHash:record.authorizationHash,requestHash:record.requestHash,offerHash:record.offerHash};
    });
  }
  markUnknown(paymentId: string, reason='TRANSPORT_UNKNOWN'): PaymentRecord {
    return this.tx(()=>{const p=this.get(paymentId);if(p.state==='SETTLED') return p;if(!LIVE.has(p.state)) throw new PaymentError('INVALID_TRANSITION');p.state='UNKNOWN';p.reasonCode=reason;return this.put(p,'UNKNOWN');});
  }
  rejectUnsigned(paymentId: string, reason: string): PaymentRecord {
    return this.tx(()=>{const row=this.db.prepare('SELECT data,stage FROM mg_payments WHERE payment_id=?').get(paymentId) as Row|undefined;if(!row) throw new PaymentError('PAYMENT_NOT_FOUND');const p=JSON.parse(row.data) as PaymentRecord;if(p.state!=='RESERVED'||row.stage==='SIGNING'||p.nonce) throw new PaymentError('AUTHORIZATION_MAY_EXIST');p.state='REJECTED';p.reasonCode=reason;return this.put(p);});
  }
  revoke(taskId: string): void {
    this.tx(()=>{this.getAuthorization(taskId);if(this.db.prepare("SELECT payment_id FROM mg_payments WHERE task_id=? AND stage='SIGNING'").get(taskId)) throw new PaymentError('SIGNING_IN_PROGRESS');this.db.prepare('UPDATE mg_grants SET revoked=1,version=version+1 WHERE task_id=?').run(taskId);});
  }
  /** Call only after the previous signer child is terminated/disconnected. No old C may receive a new dispatch acknowledgment. */
  recover(): number {
    return this.tx(()=>{let count=0;for(const row of this.db.prepare('SELECT data,stage FROM mg_payments').all() as Row[]){const p=JSON.parse(row.data) as PaymentRecord;if(['SIGNED','DISPATCHED'].includes(p.state)||row.stage==='SIGNING'){p.state='UNKNOWN';p.reasonCode='RESTART_UNCERTAIN';this.put(p,'UNKNOWN');count++;}}return count;});
  }
  fundSandbox(account: string, amountAtomic: string): void {
    if(this.executionMode!=='MOCK') throw new PaymentError('SANDBOX_ONLY');atomic(amountAtomic);
    this.tx(()=>{this.db.prepare('INSERT INTO mg_sandbox_balances(account,asset,amount) VALUES(?,?,?) ON CONFLICT(account,asset) DO UPDATE SET amount=excluded.amount').run(account.toLowerCase(),'USDC',amountAtomic);});
  }
  settleSandbox(proof: SandboxSettlementProof): PaymentRecord {
    if(this.executionMode!=='MOCK'||proof.cryptographicallyVerified!==true) throw new PaymentError('SANDBOX_ONLY');
    return this.tx(()=>{
      const p=this.get(proof.paymentId);
      if(p.state==='SETTLED') {if(p.authorizationHash!==proof.authorizationHash)throw new PaymentError('SETTLEMENT_MISMATCH');return p;}
      if(!['DISPATCHED','UNKNOWN'].includes(p.state)||p.nonce!==proof.nonce||p.authorizationHash!==proof.authorizationHash||p.signerAddress?.toLowerCase()!==proof.from.toLowerCase()||p.payTo.toLowerCase()!==proof.to.toLowerCase()||p.amountAtomic!==proof.amountAtomic||p.validBefore!==proof.validBefore||canonicalJson(p.asset)!==canonicalJson(proof.asset)||this.now()<=proof.validAfter||this.now()>=proof.validBefore) throw new PaymentError('SETTLEMENT_MISMATCH');
      const balance=this.db.prepare('SELECT amount FROM mg_sandbox_balances WHERE account=? AND asset=?').get(proof.from.toLowerCase(),'USDC') as {amount:string}|undefined;
      if(!balance||atomic(balance.amount)<atomic(p.amountAtomic)) throw new PaymentError('INSUFFICIENT_SANDBOX_BALANCE');
      try{this.db.prepare('INSERT INTO mg_sandbox_nonces(asset,sender,nonce) VALUES(?,?,?)').run(p.asset.tokenAddress.toLowerCase(),proof.from.toLowerCase(),proof.nonce);}catch{throw new PaymentError('NONCE_ALREADY_USED');}
      this.db.prepare('UPDATE mg_sandbox_balances SET amount=? WHERE account=? AND asset=?').run((atomic(balance.amount)-atomic(p.amountAtomic)).toString(),proof.from.toLowerCase(),'USDC');
      p.state='SETTLED';p.reasonCode='SANDBOX_CRYPTOGRAPHIC_SETTLEMENT';return this.put(p,'SETTLED');
    });
  }
  settleTestnet(proof:VerifiedTestnetSettlement):PaymentRecord{
    if(this.executionMode!=='TESTNET')throw new PaymentError('TESTNET_ONLY');
    return this.tx(()=>{const p=this.get(proof.paymentId);if(p.state==='SETTLED'){if(p.transactionHash!==proof.transactionHash)throw new PaymentError('SETTLEMENT_MISMATCH');return p;}
      if(!['DISPATCHED','UNKNOWN'].includes(p.state)||proof.authorizationUsed!==true||proof.confirmations<2||proof.network!==p.asset.network||canonicalJson(proof.asset)!==canonicalJson(p.asset)||p.nonce!==proof.nonce||p.authorizationHash!==proof.authorizationHash||p.validBefore!==proof.validBefore||p.signerAddress?.toLowerCase()!==proof.from.toLowerCase()||p.payTo.toLowerCase()!==proof.to.toLowerCase()||p.amountAtomic!==proof.amountAtomic||!/^0x[\da-f]{64}$/i.test(proof.transactionHash))throw new PaymentError('SETTLEMENT_MISMATCH');
      p.state='SETTLED';p.transactionHash=proof.transactionHash;p.reasonCode='RPC_VERIFIED_TESTNET_SETTLEMENT';return this.put(p,'SETTLED');});
  }
  getSigningPermit(paymentId:string):SigningPermit{
    const row=this.db.prepare('SELECT data FROM mg_permits WHERE payment_id=?').get(paymentId) as {data:string}|undefined;
    if(!row)throw new PaymentError('SIGNING_PERMIT_NOT_FOUND');return JSON.parse(row.data) as SigningPermit;
  }
  recordTestnetTransaction(paymentId:string,transactionHash:`0x${string}`):void{
    if(this.executionMode!=='TESTNET'||!/^0x[\da-f]{64}$/i.test(transactionHash))throw new PaymentError('INVALID_TESTNET_CANDIDATE');
    this.tx(()=>{const p=this.get(paymentId);if(!['DISPATCHED','UNKNOWN'].includes(p.state)||!p.nonce||!p.signerAddress||!p.authorizationHash)throw new PaymentError('PAYMENT_NOT_DISPATCHED');
      const old=this.getTestnetTransaction(paymentId);if(old&&old!==transactionHash)throw new PaymentError('TRANSACTION_CANDIDATE_CONFLICT');
      this.db.prepare('INSERT INTO mg_testnet_candidates(payment_id,transaction_hash) VALUES(?,?) ON CONFLICT(payment_id) DO NOTHING').run(paymentId,transactionHash);
    });
  }
  getTestnetTransaction(paymentId:string):`0x${string}`|null{
    const row=this.db.prepare('SELECT transaction_hash FROM mg_testnet_candidates WHERE payment_id=?').get(paymentId) as {transaction_hash:`0x${string}`}|undefined;
    return row?.transaction_hash??null;
  }
  expireSandbox(paymentId:string):PaymentRecord{
    if(this.executionMode!=='MOCK')throw new PaymentError('SANDBOX_ONLY');
    return this.tx(()=>{const p=this.get(paymentId);if(!['UNKNOWN','SIGNED','DISPATCHED'].includes(p.state)||p.validBefore===null||this.now()<p.validBefore||!p.nonce||!p.signerAddress)throw new PaymentError('EXPIRY_NOT_PROVEN');
      if(this.db.prepare('SELECT nonce FROM mg_sandbox_nonces WHERE asset=? AND sender=? AND nonce=?').get(p.asset.tokenAddress.toLowerCase(),p.signerAddress.toLowerCase(),p.nonce))throw new PaymentError('AUTHORIZATION_ALREADY_USED');p.state='EXPIRED';p.reasonCode='SANDBOX_UNUSED_AUTHORIZATION_EXPIRED';return this.put(p,'EXPIRED');});
  }
}
