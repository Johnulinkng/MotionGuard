import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { hashTypedData } from 'viem';
import { canonicalJson } from '../payment/canonical.js';
import { PaymentError,type DispatchCommit,type Hex,type PaymentRecord,type SignedMetadata,type SigningPermit,type TestnetReconciliation } from '../payment/types.js';
import { payRegisteredTestnetResource } from '../payment/x402.js';
import { assertTestnetRpc,verifyTestnetReceipt } from '../payment/reconcile.js';
import { candidateForTestnetPayment,signAuthorization,transferTypedData,type SignedAuthorization } from './eip3009.js';

// Explicitly configured domain C. A file path, never the key value, crosses the parent's IPC setup.
if(!process.send||process.env.MOTION_TESTNET_ENABLED!=='true')throw new Error('Testnet signer requires explicit private IPC setup');
const key=readFileSync(process.env.MOTION_TESTNET_KEY_FILE!,'utf8').trim() as Hex;
if(!/^0x[\da-f]{64}$/i.test(key))throw new Error('Invalid testnet key file');
const rpcUrl=process.env.MOTION_TESTNET_RPC_URL!;
const rpc=new URL(rpcUrl);if(rpc.protocol!=='https:'||rpc.username||rpc.password||rpc.hash)throw new Error('Invalid fixed testnet RPC');
const address=privateKeyToAccount(key).address;
const callbacks=new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
function ask<T>(id:string,op:string,payload?:unknown):Promise<T>{return new Promise((resolve,reject)=>{
  const callbackId=randomUUID();const timer=setTimeout(()=>{callbacks.delete(callbackId);reject(new PaymentError('GATEWAY_ACK_TIMEOUT'));},5000);
  callbacks.set(callbackId,{resolve:value=>resolve(value as T),reject,timer});process.send?.({type:'callback',id,callbackId,op,payload});
});}
process.on('disconnect',()=>process.exit(0));
process.send({type:'ready',address});
let queue=Promise.resolve();
process.on('message',(raw:unknown)=>{
  const msg=raw as {type?:string;id:string;op?:string;payload?:unknown;callbackId?:string;result?:unknown;code?:string};
  if(msg.type==='callback-result'&&msg.callbackId){const pending=callbacks.get(msg.callbackId);if(!pending)return;clearTimeout(pending.timer);callbacks.delete(msg.callbackId);if(msg.code)pending.reject(new PaymentError(msg.code));else pending.resolve(msg.result);return;}
  queue=queue.then(async()=>{
    try{
      if(typeof msg.id!=='string')throw new PaymentError('UNSUPPORTED_SIGNER_OPERATION');
      if(msg.op==='reconcile'){
        const {payment:p,permit,transactionHash}=msg.payload as TestnetReconciliation;
        if(p.executionMode!=='TESTNET'||permit.executionMode!=='TESTNET'||!p.signerAddress||!p.nonce||p.validBefore===null||!p.authorizationHash||permit.paymentId!==p.paymentId||permit.taskId!==p.taskId||permit.authorizationVersion!==p.authorizationVersion||permit.nonce!==p.nonce||permit.validBefore!==p.validBefore||permit.amountAtomic!==p.amountAtomic||permit.payTo.toLowerCase()!==p.payTo.toLowerCase()||permit.requestHash!==p.requestHash||permit.offerHash!==p.offerHash||canonicalJson(permit.asset)!==canonicalJson(p.asset)||hashTypedData(transferTypedData(permit,p.signerAddress))!==p.authorizationHash)throw new PaymentError('RECONCILIATION_BINDING_MISMATCH');
        const metadata:SignedMetadata={paymentId:p.paymentId,permitId:permit.permitId,nonce:p.nonce,validBefore:p.validBefore,signerAddress:p.signerAddress,authorizationHash:p.authorizationHash};
        const proof=await verifyTestnetReceipt({rpcUrl,transactionHash,permit,metadata});
        process.send?.({type:'result',id:msg.id,result:proof});return;
      }
      if(msg.op!=='pay')throw new PaymentError('UNSUPPORTED_SIGNER_OPERATION');
      const payment=msg.payload as PaymentRecord;
      if(payment.executionMode!=='TESTNET'||payment.state!=='RESERVED')throw new PaymentError('TESTNET_ONLY');
      // Fail before authorization if the fixed verification RPC is unavailable or points to another chain.
      await assertTestnetRpc(rpcUrl);
      let permit:SigningPermit|undefined;let bundle:SignedAuthorization|undefined;let signedAck=false;
      const result=await payRegisteredTestnetResource({enabled:true,payment,signer:{address,async signTypedData(candidate){
        if(bundle)throw new PaymentError('SECOND_SIGNATURE_FORBIDDEN');
        const candidateWindow=candidateForTestnetPayment(payment,address,candidate);
        permit=await ask<SigningPermit>(msg.id,'beginSigning',candidateWindow);
        bundle=await signAuthorization(key,permit);
        if(canonicalJson(candidate)!==canonicalJson(bundle.typedData))throw new PaymentError('TYPED_DATA_NOT_AUTHORIZED');
        return bundle.signature;
      }},authorize:async()=>true,afterPayloadCreated:async()=>{
        if(!bundle)throw new PaymentError('SIGNATURE_NOT_AVAILABLE');
        await ask(msg.id,'signed',bundle.metadata);signedAck=true;
      },beforeDispatch:async()=>{
        if(!bundle||!signedAck)throw new PaymentError('DURABLE_SIGNATURE_ACK_REQUIRED');
        const commit=await ask<DispatchCommit>(msg.id,'beforeDispatch');
        const expected={...bundle.metadata,requestHash:payment.requestHash,offerHash:payment.offerHash};
        if(canonicalJson(commit)!==canonicalJson(expected))throw new PaymentError('DURABLE_COMMIT_MISMATCH');
      },settlementCandidate:async transactionHash=>{await ask(msg.id,'settlementCandidate',transactionHash);}});
      if(!bundle||!permit)throw new PaymentError('SIGNATURE_NOT_AVAILABLE');
      const proof=await verifyTestnetReceipt({rpcUrl,transactionHash:result.transactionHash,permit,metadata:bundle.metadata});
      process.send?.({type:'result',id:msg.id,result:proof});
    }catch(error){process.send?.({type:'error',id:msg?.id,code:error instanceof PaymentError?error.code:'TESTNET_PAYMENT_UNKNOWN'});}
  }).catch(()=>undefined);
});
