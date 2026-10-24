import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey,privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataAddress } from 'viem';
import type { PaymentRequired } from '@x402/core/types';
import { createThinX402Client } from '../src/payment/x402.js';
import { BASE_SEPOLIA_USDC } from '../src/payment/types.js';

function quote():PaymentRequired{return {x402Version:2,resource:{url:'https://merchant.example/document',description:'Evidence document',mimeType:'application/json'},accepts:[{scheme:'exact',network:'eip155:84532',asset:BASE_SEPOLIA_USDC,amount:'30',payTo:'0x1111111111111111111111111111111111111111',maxTimeoutSeconds:60,extra:{name:'USDC',version:'2',assetTransferMethod:'eip3009'}}]};}
test('official x402 2.28.0 before-payment abort executes before cryptographic signer',async()=>{
  const account=privateKeyToAccount(generatePrivateKey());let signed=0;
  const client=createThinX402Client({signer:{address:account.address,async signTypedData(){signed++;throw new Error('must never sign');}},payment:{amountAtomic:'30',payTo:quote().accepts[0]!.payTo,maxTimeoutSeconds:60},authorize:async()=>false});
  await assert.rejects(()=>client.createPaymentPayload(quote()),/Payment creation aborted: EXPLICIT_ALLOW_REQUIRED/);assert.equal(signed,0);
});
test('SDK hook blocks changed recipient, price, network, scheme, transfer method and extensions',async()=>{
  const account=privateKeyToAccount(generatePrivateKey());let signed=0;
  const client=createThinX402Client({signer:{address:account.address,async signTypedData(){signed++;throw new Error('must never sign');}},payment:{amountAtomic:'30',payTo:quote().accepts[0]!.payTo,maxTimeoutSeconds:60},expectedResourceUrl:quote().resource.url,authorize:async()=>true});
  const changes=[{payTo:'0x2222222222222222222222222222222222222222'},{amount:'31'},{network:'eip155:1'},{scheme:'upto'},{extra:{name:'USDC',version:'2',assetTransferMethod:'permit2'}},{extra:{name:'USDC',version:'1'}},{maxTimeoutSeconds:61}];
  for(const change of changes){const q=quote();Object.assign(q.accepts[0]!,change);await assert.rejects(()=>client.createPaymentPayload(q));}
  const ext=quote();ext.extensions={evil:{}};await assert.rejects(()=>client.createPaymentPayload(ext));
  const url=quote();url.resource.url='https://attacker.example/';await assert.rejects(()=>client.createPaymentPayload(url));assert.equal(signed,0);
});
test('official SDK payload carries a real recoverable signature and awaits durable signed acknowledgment',async()=>{
  const account=privateKeyToAccount(generatePrivateKey());let acknowledged=false;let candidate:Parameters<typeof account.signTypedData>[0]|undefined;
  const client=createThinX402Client({signer:{address:account.address,async signTypedData(data){candidate=data;return account.signTypedData(data);}},payment:{amountAtomic:'30',payTo:quote().accepts[0]!.payTo,maxTimeoutSeconds:60},authorize:async()=>true,afterPayloadCreated:async()=>{await new Promise(r=>setTimeout(r,10));acknowledged=true;}});
  const payload=await client.createPaymentPayload(quote());assert.equal(acknowledged,true);assert.ok(candidate);
  const signature=(payload.payload as {signature:`0x${string}`}).signature;assert.equal(await recoverTypedDataAddress({...candidate,signature}),account.address);
  const fail=createThinX402Client({signer:account,payment:{amountAtomic:'30',payTo:quote().accepts[0]!.payTo,maxTimeoutSeconds:60},authorize:async()=>true,afterPayloadCreated:async()=>{throw new Error('DURABLE_ACK_FAILED');}});
  await assert.rejects(()=>fail.createPaymentPayload(quote()),/DURABLE_ACK_FAILED/);
});
