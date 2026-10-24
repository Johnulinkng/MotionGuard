import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PaymentError,type Hex,type PaymentRecord,type PrivateSigner,type TestnetHandshake,type TestnetReconciliation,type VerifiedTestnetSettlement } from '../payment/types.js';

export interface TestnetSignerOptions{enabled:true;keyFile:string;rpcUrl:string;timeoutMs?:number}
/** Configuration-only API. Never expose this constructor or the file path through operator HTTP. */
export async function createConfiguredTestnetSigner(options:TestnetSignerOptions):Promise<PrivateSigner>{
  if(options.enabled!==true)throw new PaymentError('TESTNET_NOT_ENABLED');
  if(!isAbsolute(options.keyFile))throw new PaymentError('ABSOLUTE_KEY_FILE_REQUIRED');
  const rpc=new URL(options.rpcUrl);if(rpc.protocol!=='https:'||rpc.username||rpc.password||rpc.hash)throw new PaymentError('UNSAFE_RPC');
  const extension=import.meta.url.endsWith('.ts')?'.ts':'.js';
  const child=fork(fileURLToPath(new URL(`./testnet-worker${extension}`,import.meta.url)),[],{stdio:['ignore','ignore','ignore','ipc'],serialization:'json',execArgv:extension==='.ts'?['--import','tsx']:[],env:{SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,NODE_ENV:'production',MOTION_TESTNET_ENABLED:'true',MOTION_TESTNET_KEY_FILE:options.keyFile,MOTION_TESTNET_RPC_URL:options.rpcUrl}});
  const pending=new Map<string,{hooks?:TestnetHandshake;resolve:(proof:VerifiedTestnetSettlement)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  let address:Hex|undefined;let exited=false;let closed=false;
  let readyResolve:(address:Hex)=>void=()=>{};let readyReject:(error:Error)=>void=()=>{};
  const ready=new Promise<Hex>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const exit=new Promise<void>(resolve=>child.once('exit',()=>{exited=true;resolve();}));
  const fail=()=>{closed=true;clearTimeout(startTimer);readyReject(new PaymentError('SIGNER_START_FAILED'));for(const p of pending.values()){clearTimeout(p.timer);p.reject(new PaymentError('SIGNER_DISCONNECTED'));}pending.clear();};
  child.on('exit',fail);child.on('error',fail);
  const startTimer=setTimeout(()=>{readyReject(new PaymentError('SIGNER_START_TIMEOUT'));child.kill();},options.timeoutMs??5000);
  child.on('message',(raw:unknown)=>{void (async()=>{
    const msg=raw as {type:string;id?:string;address?:Hex;op?:string;payload?:unknown;callbackId?:string;result?:VerifiedTestnetSettlement;code?:string};
    if(msg.type==='ready'&&msg.address){address=msg.address;clearTimeout(startTimer);readyResolve(address);return;}
    if(!msg.id)return;const item=pending.get(msg.id);if(!item)return;
    if(msg.type==='callback'&&msg.callbackId){
      try{if(!item.hooks)throw new PaymentError('INVALID_SIGNER_CALLBACK');let result:unknown;if(msg.op==='beginSigning')result=await item.hooks.beginSigning(msg.payload as Parameters<TestnetHandshake['beginSigning']>[0]);else if(msg.op==='signed')result=await item.hooks.signed(msg.payload as Parameters<TestnetHandshake['signed']>[0]);else if(msg.op==='beforeDispatch')result=await item.hooks.beforeDispatch();else if(msg.op==='settlementCandidate')result=await item.hooks.settlementCandidate(msg.payload as Hex);else throw new PaymentError('INVALID_SIGNER_CALLBACK');
        if(child.connected)child.send({type:'callback-result',callbackId:msg.callbackId,result});
      }catch(error){if(child.connected)child.send({type:'callback-result',callbackId:msg.callbackId,code:error instanceof PaymentError?error.code:'GATEWAY_ACK_FAILED'});}
      return;
    }
    clearTimeout(item.timer);pending.delete(msg.id);if(msg.type==='result'&&msg.result)item.resolve(msg.result);else item.reject(new PaymentError(msg.code??'TESTNET_PAYMENT_UNKNOWN'));
  })().catch(()=>fail());});
  async function close():Promise<void>{fail();if(child.connected)child.disconnect();if(exited||child.exitCode!==null||!child.pid)return;child.kill();await exit;}
  try{await ready;}catch(error){await close();throw error;}
  function call(op:string,payload:unknown,hooks?:TestnetHandshake):Promise<VerifiedTestnetSettlement>{
    if(closed||!child.connected)return Promise.reject(new PaymentError('SIGNER_DISCONNECTED'));
    const id=randomUUID();return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(new PaymentError('TESTNET_PAYMENT_TIMEOUT'));void close();},options.timeoutMs??60000);
      pending.set(id,{hooks,resolve,reject,timer});child.send({id,op,payload},error=>{if(error){clearTimeout(timer);pending.delete(id);reject(new PaymentError('SIGNER_DISCONNECTED'));}});
    });
  }
  return {address:address!,pid:child.pid,signPermit:async()=>{throw new PaymentError('DIRECT_TESTNET_SIGN_FORBIDDEN');},settleSandbox:async()=>{throw new PaymentError('SANDBOX_ONLY');},payTestnet:(payment:PaymentRecord,hooks:TestnetHandshake)=>call('pay',payment,hooks),reconcileTestnet:(input:TestnetReconciliation)=>call('reconcile',input),close};
}
