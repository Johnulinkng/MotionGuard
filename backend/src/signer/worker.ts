import { privateKeyToAccount } from 'viem/accounts';
import { canonicalJson } from '../payment/canonical.js';
import { PaymentError, type DispatchCommit, type SandboxSettlementProof, type SigningPermit } from '../payment/types.js';
import { ephemeralSandboxKey, signAuthorization, verifySandboxAuthorization, type SignedAuthorization } from './eip3009.js';

// This child has no HTTP listener and no network transport. Even a real EIP-712 signature uses
// a newly generated, unfunded key; sandbox proof is explicitly not an on-chain transaction.
const key=ephemeralSandboxKey();
const address=privateKeyToAccount(key).address;
const signed=new Map<string,SignedAuthorization>();
const consumed=new Set<string>();
let queue=Promise.resolve();
if(!process.send) throw new Error('Signer requires an inherited private IPC channel');
process.send({type:'ready',address});
process.on('disconnect',()=>process.exit(0));
process.on('message',(message:unknown)=>{
  queue=queue.then(async()=>{
    const msg=message as {id:string;op:string;payload:unknown;now?:number};
    try {
      if(!msg||typeof msg.id!=='string') throw new PaymentError('INVALID_IPC_REQUEST');
      if(msg.now!==undefined&&(!Number.isSafeInteger(msg.now)||msg.now<0))throw new PaymentError('INVALID_SANDBOX_CLOCK');
      let result:unknown;
      if(msg.op==='sign') {
        const permit=msg.payload as SigningPermit;
        if(permit.executionMode!=='MOCK') throw new PaymentError('SANDBOX_ONLY');
        const previous=signed.get(permit.paymentId);
        if(previous) {
          if(canonicalJson(previous.permit)!==canonicalJson(permit)) throw new PaymentError('SIGNER_IDEMPOTENCY_CONFLICT');
          result=previous.metadata;
        } else {const bundle=await signAuthorization(key,permit,msg.now===undefined?undefined:()=>msg.now!);signed.set(permit.paymentId,bundle);result=bundle.metadata;}
      } else if(msg.op==='settle') {
        const commit=msg.payload as DispatchCommit; const bundle=signed.get(commit.paymentId);
        if(!bundle||consumed.has(commit.paymentId)) throw new PaymentError('SIGNATURE_NOT_AVAILABLE');
        const expected={...bundle.metadata,requestHash:bundle.permit.requestHash,offerHash:bundle.permit.offerHash};
        if(canonicalJson(commit)!==canonicalJson(expected)) throw new PaymentError('DURABLE_COMMIT_MISMATCH');
        await verifySandboxAuthorization(bundle,msg.now);
        const proof:SandboxSettlementProof={...bundle.metadata,cryptographicallyVerified:true,asset:bundle.permit.asset,from:address,to:bundle.permit.payTo,amountAtomic:bundle.permit.amountAtomic,validAfter:bundle.permit.validAfter,sandboxReceiptId:`sandbox_${commit.paymentId}`};
        consumed.add(commit.paymentId);result=proof;
      } else throw new PaymentError('UNSUPPORTED_SIGNER_OPERATION');
      process.send?.({type:'result',id:msg.id,result});
    } catch(error) {process.send?.({type:'error',id:msg?.id,code:error instanceof PaymentError?error.code:'SIGNER_FAILED'});}
  }).catch(()=>undefined);
});
