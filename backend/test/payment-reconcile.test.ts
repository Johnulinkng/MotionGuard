import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey,privateKeyToAccount } from 'viem/accounts';
import { encodeAbiParameters,encodeEventTopics,parseAbi,type TransactionReceipt } from 'viem';
import { verifyTestnetReceiptEvidence,type TestnetReceiptEvidence } from '../src/payment/reconcile.js';
import { BASE_SEPOLIA_USDC,type SigningPermit } from '../src/payment/types.js';
import { signAuthorization } from '../src/signer/eip3009.js';

const ABI=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)','event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)']);
const HASH=`0x${'a'.repeat(64)}` as const;
async function fixture(){
  const now=Math.floor(Date.now()/1000),key=generatePrivateKey(),address=privateKeyToAccount(key).address;
  const permit:SigningPermit={permitId:'permit_one',paymentId:'pay_one',taskId:'task_one',authorizationVersion:1,requestHash:`sha256:${'1'.repeat(64)}`,offerHash:`sha256:${'2'.repeat(64)}`,asset:{network:'eip155:84532',tokenAddress:BASE_SEPOLIA_USDC,symbol:'USDC',decimals:6},payTo:'0x1111111111111111111111111111111111111111',amountAtomic:'30',nonce:`0x${'b'.repeat(64)}`,validAfter:0,validBefore:now+60,executionMode:'TESTNET'};
  const bundle=await signAuthorization(key,permit);
  const common={address:BASE_SEPOLIA_USDC,blockNumber:100n,blockHash:HASH,transactionHash:HASH,transactionIndex:0,removed:false};
  const logs=[{...common,logIndex:0,topics:encodeEventTopics({abi:ABI,eventName:'AuthorizationUsed',args:{authorizer:address,nonce:permit.nonce}}),data:'0x'},{...common,logIndex:1,topics:encodeEventTopics({abi:ABI,eventName:'Transfer',args:{from:address,to:permit.payTo}}),data:encodeAbiParameters([{type:'uint256'}],[30n])}] as TransactionReceipt['logs'];
  const evidence:TestnetReceiptEvidence={chainId:84532,latestBlock:101n,receipt:{status:'success',blockNumber:100n,transactionHash:HASH,logs}};
  return {binding:{transactionHash:HASH,permit,metadata:bundle.metadata},evidence};
}
test('receipt fixture checks require fixed chain, confirmations, token, nonce and matching transfer',async()=>{
  const {binding,evidence}=await fixture();const proof=verifyTestnetReceiptEvidence(binding,evidence);assert.equal(proof.authorizationUsed,true);assert.equal(proof.confirmations,2);
  assert.throws(()=>verifyTestnetReceiptEvidence(binding,{...evidence,chainId:1}),/RPC_WRONG_NETWORK/);
  assert.throws(()=>verifyTestnetReceiptEvidence(binding,{...evidence,latestBlock:100n}),/SETTLEMENT_PENDING/);
  assert.throws(()=>verifyTestnetReceiptEvidence(binding,{...evidence,receipt:{...evidence.receipt,status:'reverted'}}),/SETTLEMENT_PENDING/);
  assert.throws(()=>verifyTestnetReceiptEvidence(binding,{...evidence,receipt:{...evidence.receipt,transactionHash:`0x${'c'.repeat(64)}`}}),/SETTLEMENT_TRANSACTION_MISMATCH/);
  assert.throws(()=>verifyTestnetReceiptEvidence(binding,{...evidence,receipt:{...evidence.receipt,logs:evidence.receipt.logs.slice(1)}}),/SETTLEMENT_EVENTS_MISMATCH/);
  assert.throws(()=>verifyTestnetReceiptEvidence(binding,{...evidence,receipt:{...evidence.receipt,logs:evidence.receipt.logs.map(log=>({...log,address:'0x2222222222222222222222222222222222222222'}))}}),/SETTLEMENT_EVENTS_MISMATCH/);
  const wrongAmount=structuredClone(evidence);wrongAmount.receipt.logs[1]!.data=encodeAbiParameters([{type:'uint256'}],[31n]);assert.throws(()=>verifyTestnetReceiptEvidence(binding,wrongAmount),/SETTLEMENT_EVENTS_MISMATCH/);
  const wrongNonce=structuredClone(evidence);wrongNonce.receipt.logs[0]!.topics=encodeEventTopics({abi:ABI,eventName:'AuthorizationUsed',args:{authorizer:binding.metadata.signerAddress,nonce:`0x${'d'.repeat(64)}`}}) as TransactionReceipt['logs'][number]['topics'];assert.throws(()=>verifyTestnetReceiptEvidence(binding,wrongNonce),/SETTLEMENT_EVENTS_MISMATCH/);
  assert.throws(()=>verifyTestnetReceiptEvidence({...binding,metadata:{...binding.metadata,authorizationHash:`0x${'e'.repeat(64)}`}},evidence),/RECONCILIATION_BINDING_MISMATCH/);
});
