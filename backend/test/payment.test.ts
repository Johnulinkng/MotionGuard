import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { hashResourcePlan } from '../src/payment/canonical.js';
import { BASE_SEPOLIA_USDC,PaymentError,type FrozenAuthorizationInput,type PaymentIntent,type PrivateSigner,type SigningPermit,type VerifiedTestnetSettlement } from '../src/payment/types.js';
import { SqliteLedger } from '../src/ledger/sqlite.js';
import { createSandboxSigner } from '../src/signer/ipc.js';
import { createMinimalSigner, signAuthorization, transferTypedData, verifySandboxAuthorization } from '../src/signer/eip3009.js';
import { PaymentKernel } from '../src/payment/kernel.js';

const PAYEE='0x1111111111111111111111111111111111111111';
function fixture(cap='100',calls=10):{grant:FrozenAuthorizationInput;intent:PaymentIntent}{
  const created=new Date().toISOString(),expires=new Date(Date.now()+3600000).toISOString();
  const asset={network:'eip155:84532' as const,tokenAddress:BASE_SEPOLIA_USDC,symbol:'USDC' as const,decimals:6 as const};
  const route={vendorId:'vendor_one',toolId:'tool_document',routeId:'route_read',resourceKind:'DOCUMENT' as const,payTo:PAYEE,method:'GET' as const,url:'sandbox://vendor_one/document',toolDescriptorHash:`sha256:${'1'.repeat(64)}`};
  const plan:FrozenAuthorizationInput['plan']={schemaVersion:'0.1.0',planId:'plan_one',taskId:'task_one',version:1,status:'FROZEN',goalHash:`sha256:${'2'.repeat(64)}`,catalogVersion:'catalog_one',planHash:'',items:[{itemId:'item_one',goalStepId:'step_one',resourceKind:'DOCUMENT',toolId:route.toolId,vendorId:route.vendorId,routeId:route.routeId,selectors:{entityIds:['entity_one']},unitPriceCapAtomic:cap,maxPaidCalls:calls,subtotalCapAtomic:cap,dependsOn:[],purpose:'Buy evidence'}],totalCapAtomic:cap,expiresAt:expires,createdAt:created};
  plan.planHash=hashResourcePlan(plan);
  const grant:FrozenAuthorizationInput={taskId:'task_one',plan,catalog:{schemaVersion:'0.1.0',catalogVersion:'catalog_one',asset,vendors:[{...route,name:'Evidence',description:'Trusted description'}]},routes:[route],authorization:{authorizationId:'auth_one',version:1,status:'ACTIVE',planHash:plan.planHash,goalHash:plan.goalHash,catalogVersion:plan.catalogVersion,budgetAtomic:cap,maxPaidCalls:calls,expiresAt:expires,authorizedAt:created,revokedAt:null}};
  const intent:PaymentIntent={taskId:'task_one',planItemId:'item_one',logicalPurchaseId:'purchase_one',vendorId:route.vendorId,toolId:route.toolId,routeId:route.routeId,resourceKind:'DOCUMENT',method:'GET',selectors:{entityIds:['entity_one']},amountAtomic:'30',payTo:PAYEE,asset};
  return {grant,intent};
}
function tempLedger(){const dir=mkdtempSync(join(tmpdir(),'motion-ledger-'));return {dir,path:join(dir,'ledger.sqlite'),cleanup:()=>rmSync(dir,{recursive:true,force:true})};}

test('persistent BigInt reservations, immutable grant and logical-purchase idempotency',()=>{
  const t=tempLedger();let ledger=new SqliteLedger({path:t.path});
  try{
    const {grant,intent}=fixture('100000000000000000000000000000');ledger.freezeAuthorization(grant);
    const large={...intent,amountAtomic:'99999999999999999999999999999'};const first=ledger.reserve(large);
    assert.equal(ledger.reserve(large).paymentId,first.paymentId);
    assert.equal(ledger.budget('task_one').availableAtomic,'1');
    assert.throws(()=>ledger.reserve({...large,amountAtomic:'1'}),/IDEMPOTENCY_CONFLICT/);
    const changed=structuredClone(grant);changed.authorization.budgetAtomic='10';assert.throws(()=>ledger.freezeAuthorization(changed),/AUTHORIZATION_IMMUTABLE/);
    ledger.close();ledger=new SqliteLedger({path:t.path});assert.equal(ledger.get(first.paymentId).state,'RESERVED');assert.equal(ledger.budget('task_one').reservedAtomic,large.amountAtomic);
  }finally{ledger.close();t.cleanup();}
});
test('resource, selector, address, price, method and authorization hard gates',()=>{
  const ledger=new SqliteLedger({path:':memory:'});const {grant,intent}=fixture();ledger.freezeAuthorization(grant);
  try{
    assert.throws(()=>ledger.reserve({...intent,payTo:'0x2222222222222222222222222222222222222222'}),/PAYMENT_ROUTE_MISMATCH/);
    assert.throws(()=>ledger.reserve({...intent,amountAtomic:'101'}),/PRICE_CAP_EXCEEDED/);
    assert.throws(()=>ledger.reserve({...intent,amountAtomic:'1.1'}),/INVALID_ATOMIC_AMOUNT/);
    assert.throws(()=>ledger.reserve({...intent,selectors:{entityIds:['entity_attack']}}),/SELECTOR_NOT_AUTHORIZED/);
    assert.throws(()=>ledger.reserve({...intent,method:'POST'}),/PAYMENT_ROUTE_MISMATCH/);
    assert.throws(()=>ledger.reserve({...intent,body:{address:'attacker'}}),/BODY_NOT_AUTHORIZED/);
    assert.throws(()=>ledger.reserve({...intent,maxTimeoutSeconds:900}),/AUTHORIZATION_TOO_LONG/);
    ledger.revoke('task_one');assert.equal(ledger.getAuthorization('task_one').authorization.version,2);assert.throws(()=>ledger.reserve(intent),/AUTHORIZATION_REVOKED/);
  }finally{ledger.close();}
});
test('cross-process reservations never overspend or count the same intent twice',async()=>{
  const t=tempLedger();const ledger=new SqliteLedger({path:t.path});const {grant,intent}=fixture('100');ledger.freezeAuthorization(grant);
  const moduleUrl=new URL('../src/ledger/sqlite.ts',import.meta.url).href;
  const code=`import {SqliteLedger} from ${JSON.stringify(moduleUrl)};const l=new SqliteLedger({path:process.argv[1]});try{const p=l.reserve(JSON.parse(process.argv[2]));console.log(JSON.stringify({ok:true,id:p.paymentId}));}catch(e){console.log(JSON.stringify({ok:false,code:e.code}));}finally{l.close();}`;
  try{
    const run=(n:number)=>new Promise<{ok:boolean;id?:string;code?:string}>((resolve,reject)=>{const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code,t.path,JSON.stringify({...intent,logicalPurchaseId:`purchase_${n}`})],{cwd:fileURLToPath(new URL('..',import.meta.url)),windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);child.on('error',reject);child.on('exit',exit=>{if(exit!==0)reject(new Error(err));else resolve(JSON.parse(out.trim()));});});
    const results=await Promise.all(Array.from({length:8},(_,n)=>run(n)));assert.equal(results.filter(r=>r.ok).length,3);assert.equal(ledger.budget('task_one').reservedAtomic,'90');assert.equal(ledger.budget('task_one').availableAtomic,'10');
    const winner=results.findIndex(r=>r.ok);const retries=await Promise.all(Array.from({length:4},()=>run(winner)));assert.ok(retries.every(r=>r.ok&&r.id===results[winner]!.id));assert.equal(ledger.list('task_one').length,3);assert.equal(ledger.budget('task_one').reservedAtomic,'90');
  }finally{ledger.close();t.cleanup();}
});
test('real EIP-712 signatures are verified; changed amount, domain, recipient or signature is rejected',async()=>{
  const now=Math.floor(Date.now()/1000);const {intent}=fixture();const key=generatePrivateKey();const address=privateKeyToAccount(key).address;
  const permit:SigningPermit={permitId:'permit_one',paymentId:'payment_one',taskId:'task_one',authorizationVersion:1,requestHash:`sha256:${'1'.repeat(64)}`,offerHash:`sha256:${'2'.repeat(64)}`,asset:intent.asset,payTo:PAYEE,amountAtomic:'30',nonce:`0x${'a'.repeat(64)}`,validAfter:now-1,validBefore:now+60,executionMode:'MOCK'};
  const bundle=await signAuthorization(key,permit);await verifySandboxAuthorization(bundle);
  const minimal=createMinimalSigner(key,permit);assert.deepEqual(Object.keys(minimal).sort(),['address','signTypedData']);
  await assert.rejects(()=>minimal.signTypedData({...transferTypedData(permit,address),message:{...bundle.typedData.message,value:31n}}),/TYPED_DATA_NOT_AUTHORIZED/);
  await assert.rejects(()=>minimal.signTypedData({...transferTypedData(permit,address),domain:{...bundle.typedData.domain,chainId:1}}),/TYPED_DATA_NOT_AUTHORIZED/);
  await assert.rejects(()=>minimal.signTypedData({...transferTypedData(permit,address),message:{...bundle.typedData.message,to:'0x2222222222222222222222222222222222222222'}}),/TYPED_DATA_NOT_AUTHORIZED/);
  await assert.rejects(()=>verifySandboxAuthorization({...bundle,signature:`0x${'0'.repeat(130)}`}),/INVALID_CRYPTOGRAPHIC_SIGNATURE/);
});
test('private IPC signer performs sandbox crypto settlement with null on-chain hash and persists spend',async()=>{
  const t=tempLedger();const ledger=new SqliteLedger({path:t.path});const signer=await createSandboxSigner();const kernel=new PaymentKernel({ledger,signer});const {grant,intent}=fixture();ledger.freezeAuthorization(grant);ledger.fundSandbox(signer.address,'100');
  try{
    const prepared=kernel.prepare(intent);const decision={action:'ALLOW' as const,taskId:intent.taskId,requestHash:prepared.requestHash,offerHash:prepared.offerHash,authorizationVersion:1,expiresAt:new Date(Date.now()+60000).toISOString()};
    const paid=await kernel.executeSandbox(intent,decision);assert.equal(paid.state,'SETTLED');assert.equal(paid.executionMode,'MOCK');assert.equal(paid.transactionHash,null);assert.equal(ledger.budget('task_one').settledAtomic,'30');
    const again=await kernel.executeSandbox(intent,decision);assert.equal(again.paymentId,paid.paymentId);assert.equal(ledger.budget('task_one').settledAtomic,'30');
    await assert.rejects(()=>kernel.executeSandbox({...intent,logicalPurchaseId:'purchase_two'},{...decision,action:'REVIEW'}),/RISK_NOT_AUTHORIZED/);
  }finally{await kernel.close();t.cleanup();}
});
test('signing/revoke linearization and crash recovery retain possible exposure',async()=>{
  const t=tempLedger();let ledger=new SqliteLedger({path:t.path});const signer=await createSandboxSigner();const {grant,intent}=fixture();ledger.freezeAuthorization(grant);
  try{
    const record=ledger.reserve(intent);const permit=ledger.beginSigning(record.paymentId);assert.throws(()=>ledger.revoke('task_one'),/SIGNING_IN_PROGRESS/);
    const signed=await signer.signPermit(permit);ledger.markSigned(signed);ledger.revoke('task_one');ledger.close();ledger=new SqliteLedger({path:t.path});
    assert.equal(ledger.recover(),1);assert.equal(ledger.recover(),0);assert.equal(ledger.get(record.paymentId).state,'UNKNOWN');assert.equal(ledger.budget('task_one').outstandingAtomic,'30');assert.throws(()=>ledger.beginSigning(record.paymentId),/AUTHORIZATION_REVOKED/);
    assert.throws(()=>ledger.rejectUnsigned(record.paymentId,'HTTP_ERROR'),/AUTHORIZATION_MAY_EXIST/);
  }finally{await signer.close();ledger.close();t.cleanup();}
});
test('revoke between durable signed acknowledgment and dispatch prevents sending and retains exposure',async()=>{
  const ledger=new SqliteLedger({path:':memory:'});const {grant,intent}=fixture();ledger.freezeAuthorization(grant);
  try{const payment=ledger.reserve(intent),permit=ledger.beginSigning(payment.paymentId);const bundle=await signAuthorization(generatePrivateKey(),permit);ledger.markSigned(bundle.metadata);ledger.revoke('task_one');assert.throws(()=>ledger.markDispatched(payment.paymentId),/AUTHORIZATION_REVOKED/);assert.equal(ledger.get(payment.paymentId).state,'SIGNED');assert.equal(ledger.budget('task_one').outstandingAtomic,'30');}
  finally{ledger.close();}
});
test('a lost signature acknowledgment remains UNKNOWN across consecutive restarts',async()=>{
  const t=tempLedger();let ledger=new SqliteLedger({path:t.path});const signer=await createSandboxSigner();const {grant,intent}=fixture();ledger.freezeAuthorization(grant);
  try{const payment=ledger.reserve(intent),permit=ledger.beginSigning(payment.paymentId);await signer.signPermit(permit);await signer.close();ledger.close();ledger=new SqliteLedger({path:t.path});assert.equal(ledger.recover(),1);assert.equal(ledger.get(payment.paymentId).nonce,permit.nonce);assert.equal(ledger.get(payment.paymentId).state,'UNKNOWN');
    ledger.close();ledger=new SqliteLedger({path:t.path});assert.equal(ledger.recover(),0);assert.equal(ledger.reserve(intent).paymentId,payment.paymentId);assert.throws(()=>ledger.beginSigning(payment.paymentId),/PAYMENT_NOT_RESERVED/);assert.equal(ledger.budget('task_one').outstandingAtomic,'30');
  }finally{await signer.close();ledger.close();t.cleanup();}
});
test('sandbox ledger, kernel risk TTL and isolated signer share the injected clock',async()=>{
  let now=Math.floor(Date.now()/1000)+86400;const ledger=new SqliteLedger({path:':memory:',now:()=>now});const signer=await createSandboxSigner({now:()=>now});const kernel=new PaymentKernel({ledger,signer});const {grant,intent}=fixture();
  grant.plan.createdAt=new Date(now*1000).toISOString();grant.plan.expiresAt=new Date((now+3600)*1000).toISOString();grant.plan.planHash=hashResourcePlan(grant.plan);grant.authorization.planHash=grant.plan.planHash;grant.authorization.expiresAt=grant.plan.expiresAt;grant.authorization.authorizedAt=grant.plan.createdAt;ledger.freezeAuthorization(grant);ledger.fundSandbox(signer.address,'100');
  try{const prepared=ledger.prepare(intent);const decision={action:'ALLOW' as const,taskId:intent.taskId,requestHash:prepared.requestHash,offerHash:prepared.offerHash,authorizationVersion:1,expiresAt:new Date((now+30)*1000).toISOString()};assert.equal((await kernel.executeSandbox(intent,decision)).state,'SETTLED');now+=31;await assert.rejects(()=>kernel.executeSandbox({...intent,logicalPurchaseId:'purchase_two'},decision),/RISK_NOT_AUTHORIZED/);}
  finally{await kernel.close();}
});
test('testnet handshake fixture persists permit and unverified hash across restart without settling early',async()=>{
  const t=tempLedger();let ledger=new SqliteLedger({path:t.path,executionMode:'TESTNET'});const {grant,intent}=fixture();grant.routes[0]!.url='https://merchant.example/document';ledger.freezeAuthorization(grant);
  const key=generatePrivateKey(),address=privateKeyToAccount(key).address,hash=`0x${'f'.repeat(64)}` as const;let bundle:Awaited<ReturnType<typeof signAuthorization>>|undefined;
  const signer:PrivateSigner={address,async close(){},async signPermit(){throw new Error('direct signing forbidden');},async settleSandbox(){throw new Error('not sandbox');},async payTestnet(payment,hooks){
    const permit=await hooks.beginSigning({nonce:`0x${'a'.repeat(64)}`,validAfter:0,validBefore:Math.floor(Date.now()/1000)+60});bundle=await signAuthorization(key,permit);await hooks.signed(bundle.metadata);await hooks.beforeDispatch();await hooks.settlementCandidate(hash);throw new PaymentError('SETTLEMENT_PENDING');
  },async reconcileTestnet(input){assert.equal(input.permit.permitId,bundle!.permit.permitId);assert.equal(input.transactionHash,hash);return {...bundle!.metadata,network:'eip155:84532',asset:intent.asset,from:address,to:intent.payTo as `0x${string}`,amountAtomic:'30',transactionHash:hash,blockNumber:'100',confirmations:2,authorizationUsed:true} satisfies VerifiedTestnetSettlement;}};
  try{const kernel=new PaymentKernel({ledger,signer});const prepared=kernel.prepare(intent),decision={action:'ALLOW' as const,taskId:intent.taskId,requestHash:prepared.requestHash,offerHash:prepared.offerHash,authorizationVersion:1,expiresAt:new Date(Date.now()+60000).toISOString()};await assert.rejects(()=>kernel.executeTestnet(intent,decision),/SETTLEMENT_PENDING/);
    const payment=ledger.list(intent.taskId)[0]!;assert.equal(payment.state,'UNKNOWN');assert.equal(payment.transactionHash,null);assert.equal(ledger.getTestnetTransaction(payment.paymentId),hash);assert.equal(ledger.budget(intent.taskId).outstandingAtomic,'30');
    ledger.close();ledger=new SqliteLedger({path:t.path,executionMode:'TESTNET'});assert.equal(ledger.recover(),0);assert.equal(ledger.getSigningPermit(payment.paymentId).nonce,payment.nonce);const recovered=new PaymentKernel({ledger,signer});assert.equal((await recovered.reconcileTestnet(payment.paymentId)).state,'SETTLED');assert.equal(ledger.get(payment.paymentId).transactionHash,hash);assert.equal(ledger.budget(intent.taskId).settledAtomic,'30');assert.equal(ledger.budget(intent.taskId).outstandingAtomic,'0');
  }finally{ledger.close();t.cleanup();}
});
