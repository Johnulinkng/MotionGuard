import { SqliteLedger } from '../ledger/sqlite.js';
import { utcSeconds } from './canonical.js';
import { PaymentError, type BoundRiskDecision, type PaymentIntent, type PaymentRecord, type PrivateSigner } from './types.js';

/** Trusted domain-B orchestration; do not expose any of these methods as a generic front-end signer API. */
export class PaymentKernel {
  readonly ledger:SqliteLedger; readonly signer:PrivateSigner;
  constructor(options:{ledger:SqliteLedger;signer:PrivateSigner}){this.ledger=options.ledger;this.signer=options.signer;}
  prepare(intent:PaymentIntent){return this.ledger.prepare(intent);}
  async executeSandbox(intent:PaymentIntent,decision:BoundRiskDecision):Promise<PaymentRecord>{
    if(this.ledger.executionMode!=='MOCK')throw new PaymentError('SANDBOX_ONLY');
    const prepared=this.ledger.prepare(intent);const auth=this.ledger.getAuthorization(intent.taskId).authorization;
    if(!decision||decision.action!=='ALLOW'||decision.taskId!==intent.taskId||decision.requestHash!==prepared.requestHash||decision.offerHash!==prepared.offerHash||decision.authorizationVersion!==auth.version||utcSeconds(decision.expiresAt)<=this.ledger.nowSeconds())throw new PaymentError('RISK_NOT_AUTHORIZED');
    const payment=this.ledger.reserve(intent);
    if(payment.state==='SETTLED')return payment;
    if(payment.state!=='RESERVED')throw new PaymentError('AUTHORIZATION_OUTSTANDING');
    const permit=this.ledger.beginSigning(payment.paymentId);
    try {
      const metadata=await this.signer.signPermit(permit);
      this.ledger.markSigned(metadata); // durable acknowledgment before C can settle/send
      const commit=this.ledger.markDispatched(payment.paymentId);
      const proof=await this.signer.settleSandbox(commit);
      return this.ledger.settleSandbox(proof);
    }catch(error){this.ledger.markUnknown(payment.paymentId,error instanceof PaymentError?error.code:'SIGNER_OR_SETTLEMENT_UNKNOWN');throw error;}
  }
  /** Disabled by the public HTTP service until operator authentication and a funded testnet smoke exist. */
  async executeTestnet(intent:PaymentIntent,decision:BoundRiskDecision):Promise<PaymentRecord>{
    if(this.ledger.executionMode!=='TESTNET'||!this.signer.payTestnet)throw new PaymentError('TESTNET_NOT_ENABLED');
    const prepared=this.ledger.prepare(intent);const auth=this.ledger.getAuthorization(intent.taskId).authorization;
    if(!decision||decision.action!=='ALLOW'||decision.taskId!==intent.taskId||decision.requestHash!==prepared.requestHash||decision.offerHash!==prepared.offerHash||decision.authorizationVersion!==auth.version||utcSeconds(decision.expiresAt)<=this.ledger.nowSeconds())throw new PaymentError('RISK_NOT_AUTHORIZED');
    const payment=this.ledger.reserve(intent);if(payment.state==='SETTLED')return payment;
    if(payment.state!=='RESERVED')throw new PaymentError('AUTHORIZATION_OUTSTANDING');
    try{
      const proof=await this.signer.payTestnet(payment,{
        beginSigning:async candidate=>{
          // RPC and merchant challenge I/O run without a DB lock; recheck the decision after that wait.
          if(utcSeconds(decision.expiresAt)<=this.ledger.nowSeconds())throw new PaymentError('RISK_DECISION_EXPIRED');
          return this.ledger.beginSigning(payment.paymentId,candidate);
        },
        signed:async metadata=>{if(metadata.paymentId!==payment.paymentId)throw new PaymentError('SIGNING_PERMIT_MISMATCH');this.ledger.markSigned(metadata);},
        beforeDispatch:async()=>this.ledger.markDispatched(payment.paymentId),
        settlementCandidate:async transactionHash=>this.ledger.recordTestnetTransaction(payment.paymentId,transactionHash),
      });
      return this.ledger.settleTestnet(proof);
    }catch(error){this.ledger.markUnknown(payment.paymentId,error instanceof PaymentError?error.code:'TESTNET_PAYMENT_UNKNOWN');throw error;}
  }
  async reconcileTestnet(paymentId:string,candidateHash?:`0x${string}`):Promise<PaymentRecord>{
    if(this.ledger.executionMode!=='TESTNET'||!this.signer.reconcileTestnet)throw new PaymentError('TESTNET_NOT_ENABLED');
    const payment=this.ledger.get(paymentId);if(payment.state==='SETTLED')return payment;
    if(!['DISPATCHED','UNKNOWN'].includes(payment.state))throw new PaymentError('PAYMENT_NOT_DISPATCHED');
    // A receipt hash is only an untrusted lookup hint. A corrected hint is accepted only after C verifies it.
    const transactionHash=candidateHash??this.ledger.getTestnetTransaction(paymentId);if(!transactionHash)throw new PaymentError('TRANSACTION_CANDIDATE_NOT_FOUND');
    const permit=this.ledger.getSigningPermit(paymentId);
    try{return this.ledger.settleTestnet(await this.signer.reconcileTestnet({payment,permit,transactionHash}));}
    catch(error){this.ledger.markUnknown(paymentId,error instanceof PaymentError?error.code:'TESTNET_RECONCILIATION_UNKNOWN');throw error;}
  }
  async close():Promise<void>{await this.signer.close();this.ledger.close();}
}
