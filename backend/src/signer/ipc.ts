import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PaymentError, type DispatchCommit, type Hex, type PrivateSigner, type SandboxSettlementProof, type SignedMetadata, type SigningPermit } from '../payment/types.js';

export async function createSandboxSigner(options:{timeoutMs?:number;now?:()=>number}={}):Promise<PrivateSigner> {
  const timeout=options.timeoutMs??5000;
  const extension=import.meta.url.endsWith('.ts')?'.ts':'.js';
  const child:ChildProcess=fork(fileURLToPath(new URL(`./worker${extension}`,import.meta.url)),[],{
    stdio:['ignore','ignore','ignore','ipc'],serialization:'json',
    // Do not inherit --test, --input-type, inspector or parent eval arguments.
    execArgv:extension==='.ts'?['--import','tsx']:[],
    // The model runtime must not inherit this channel or the signer's process handle.
    env:{SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,NODE_ENV:'production'},
  });
  const pending=new Map<string,{resolve:(x:unknown)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  let address:Hex|undefined;let closed=false;let exited=false;
  let readyResolve:(a:Hex)=>void=()=>{};let readyReject:(e:Error)=>void=()=>{};
  const ready=new Promise<Hex>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const exit=new Promise<void>(resolve=>child.once('exit',()=>{exited=true;resolve();}));
  const fail=(code='SIGNER_DISCONNECTED')=>{closed=true;clearTimeout(readyTimer);readyReject(new PaymentError(address?code:'SIGNER_START_FAILED'));for(const p of pending.values()){clearTimeout(p.timer);p.reject(new PaymentError(code));}pending.clear();};
  child.on('exit',()=>fail());child.on('error',()=>{fail('SIGNER_PROCESS_ERROR');if(!child.pid){exited=true;}});
  const readyTimer=setTimeout(()=>{readyReject(new PaymentError('SIGNER_START_TIMEOUT'));child.kill();},timeout);
  async function close():Promise<void>{
    fail();
    if(child.connected)child.disconnect();
    if(exited||child.exitCode!==null||!child.pid)return;
    child.kill();
    // A completed close means C is gone; the caller may then safely recover its ledger.
    await exit;
  }
  child.on('message',(raw:unknown)=>{
    const msg=raw as {type:string;address?:Hex;id?:string;result?:unknown;code?:string};
    if(msg.type==='ready'&&msg.address){clearTimeout(readyTimer);address=msg.address;readyResolve(msg.address);return;}
    if(!msg.id)return;const p=pending.get(msg.id);if(!p)return;clearTimeout(p.timer);pending.delete(msg.id);
    if(msg.type==='result')p.resolve(msg.result);else p.reject(new PaymentError(msg.code??'SIGNER_FAILED'));
  });
  function call<T>(op:string,payload:unknown):Promise<T>{
    if(closed||!child.connected)return Promise.reject(new PaymentError('SIGNER_DISCONNECTED'));
    const id=randomUUID();return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(new PaymentError('SIGNER_TIMEOUT'));},timeout);
      pending.set(id,{resolve:x=>resolve(x as T),reject,timer});
      child.send({id,op,payload,...(options.now?{now:options.now()}:{} )},error=>{if(error){clearTimeout(timer);pending.delete(id);reject(new PaymentError('SIGNER_DISCONNECTED'));}});
    });
  }
  try{await ready;}catch(error){await close();throw error;}
  return {address:address!,pid:child.pid,signPermit:p=>call<SignedMetadata>('sign',p),settleSandbox:c=>call<SandboxSettlementProof>('settle',c),close};
}
