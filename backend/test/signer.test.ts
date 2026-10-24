import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generatePrivateKey,privateKeyToAccount } from 'viem/accounts';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSandboxSigner } from '../src/signer/ipc.js';
import { createConfiguredTestnetSigner } from '../src/signer/testnet-ipc.js';
import { candidateForTestnetPayment,transferTypedData } from '../src/signer/eip3009.js';
import { BASE_SEPOLIA_USDC,type PaymentRecord,type SigningPermit } from '../src/payment/types.js';

test('sandbox close waits for process exit and child does not inherit --input-type',async()=>{
  const signer=await createSandboxSigner();const pid=signer.pid;assert.ok(pid);await signer.close();assert.throws(()=>process.kill(pid,0));await signer.close();
  const url=new URL('../src/signer/ipc.ts',import.meta.url).href;
  const code=`import {createSandboxSigner} from ${JSON.stringify(url)};const s=await createSandboxSigner();console.log(JSON.stringify({ready:!!s.address}));await s.close();`;
  const result=await new Promise<string>((resolve,reject)=>{const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code],{cwd:fileURLToPath(new URL('..',import.meta.url)),windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);child.on('error',reject);child.on('exit',exit=>exit===0?resolve(out):reject(new Error(err)));});
  assert.deepEqual(JSON.parse(result),{ready:true});
});
test('testnet configuration creates a private key-holding child without network or payment on startup',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'motion-unfunded-signer-'));const key=generatePrivateKey();const path=join(dir,'ephemeral-unfunded-key');writeFileSync(path,key,{mode:0o600});
  try{
    await assert.rejects(()=>createConfiguredTestnetSigner({enabled:false as true,keyFile:path,rpcUrl:'https://rpc.example'}),/TESTNET_NOT_ENABLED/);
    await assert.rejects(()=>createConfiguredTestnetSigner({enabled:true,keyFile:path,rpcUrl:'http://127.0.0.1:8545'}),/UNSAFE_RPC/);
    const signer=await createConfiguredTestnetSigner({enabled:true,keyFile:path,rpcUrl:'https://rpc.example'});
    assert.equal(signer.address,privateKeyToAccount(key).address);assert.ok(signer.pid);assert.equal(typeof signer.payTestnet,'function');
    await assert.rejects(()=>signer.signPermit({} as SigningPermit),/DIRECT_TESTNET_SIGN_FORBIDDEN/);
    const pid=signer.pid;await signer.close();assert.throws(()=>process.kill(pid!,0));
    writeFileSync(path,'invalid-key');const started=Date.now();await assert.rejects(()=>createConfiguredTestnetSigner({enabled:true,keyFile:path,rpcUrl:'https://rpc.example'}),/SIGNER_START_FAILED/);assert.ok(Date.now()-started<4500);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('testnet SDK typed data is exact; nonce adoption cannot authorize Permit2 or altered typed data',()=>{
  const now=Math.floor(Date.now()/1000),address=privateKeyToAccount(generatePrivateKey()).address;
  const permit:SigningPermit={permitId:'permit_one',paymentId:'pay_one',taskId:'task_one',authorizationVersion:1,requestHash:`sha256:${'1'.repeat(64)}`,offerHash:`sha256:${'2'.repeat(64)}`,asset:{network:'eip155:84532',tokenAddress:BASE_SEPOLIA_USDC,symbol:'USDC',decimals:6},payTo:'0x1111111111111111111111111111111111111111',amountAtomic:'30',nonce:`0x${'a'.repeat(64)}`,validAfter:0,validBefore:now+60,executionMode:'TESTNET'};
  const payment={...permit,maxTimeoutSeconds:60} as unknown as PaymentRecord;const data=transferTypedData(permit,address);
  assert.deepEqual(candidateForTestnetPayment(payment,address,data),{nonce:permit.nonce,validAfter:0,validBefore:now+60});
  assert.throws(()=>candidateForTestnetPayment(payment,address,{...data,primaryType:'PermitTransferFrom'}),/TYPED_DATA_NOT_AUTHORIZED/);
  assert.throws(()=>candidateForTestnetPayment(payment,address,{...data,message:{...data.message,value:31n}}),/TYPED_DATA_NOT_AUTHORIZED/);
  assert.throws(()=>candidateForTestnetPayment(payment,address,{...data,domain:{...data.domain,verifyingContract:'0x2222222222222222222222222222222222222222'}}),/TYPED_DATA_NOT_AUTHORIZED/);
  assert.throws(()=>candidateForTestnetPayment(payment,address,{...data,types:{...data.types,Extra:[{name:'spender',type:'address'}]}}),/TYPED_DATA_NOT_AUTHORIZED/);
});
