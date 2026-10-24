import { createPublicClient, hashTypedData, http, parseEventLogs,type TransactionReceipt } from 'viem';
import { baseSepolia } from 'viem/chains';
import { sameAddress } from './canonical.js';
import { assertAsset } from './policy.js';
import { transferTypedData } from '../signer/eip3009.js';
import { BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_NETWORK, BASE_SEPOLIA_USDC, PaymentError, type Hex, type SignedMetadata, type SigningPermit, type VerifiedTestnetSettlement } from './types.js';

const EVENTS=[{type:'event',name:'Transfer',inputs:[{name:'from',type:'address',indexed:true},{name:'to',type:'address',indexed:true},{name:'value',type:'uint256',indexed:false}]},{type:'event',name:'AuthorizationUsed',inputs:[{name:'authorizer',type:'address',indexed:true},{name:'nonce',type:'bytes32',indexed:true}]}] as const;
export async function assertTestnetRpc(rpcUrl:string):Promise<void>{
  const rpc=new URL(rpcUrl);if(rpc.protocol!=='https:'||rpc.username||rpc.password||rpc.hash)throw new PaymentError('UNSAFE_RPC');
  const client=createPublicClient({chain:baseSepolia,transport:http(rpcUrl,{retryCount:0,timeout:10000})});
  if(await client.getChainId()!==BASE_SEPOLIA_CHAIN_ID)throw new PaymentError('RPC_WRONG_NETWORK');
}
export interface TestnetReceiptBinding{transactionHash:Hex;permit:SigningPermit;metadata:SignedMetadata;minimumConfirmations?:number}
export interface TestnetReceiptEvidence{chainId:number;latestBlock:bigint;receipt:Pick<TransactionReceipt,'logs'|'status'|'blockNumber'|'transactionHash'>}
/** Pure receipt checks also used by the configured RPC path; fixture tests never claim chain settlement. */
export function verifyTestnetReceiptEvidence(options:TestnetReceiptBinding,evidence:TestnetReceiptEvidence):VerifiedTestnetSettlement{
  assertAsset(options.permit.asset);
  if(options.permit.executionMode!=='TESTNET'||options.permit.paymentId!==options.metadata.paymentId||options.permit.permitId!==options.metadata.permitId||options.permit.nonce!==options.metadata.nonce||options.permit.validBefore!==options.metadata.validBefore||hashTypedData(transferTypedData(options.permit,options.metadata.signerAddress))!==options.metadata.authorizationHash)throw new PaymentError('RECONCILIATION_BINDING_MISMATCH');
  if(options.minimumConfirmations!==undefined&&(!Number.isSafeInteger(options.minimumConfirmations)||options.minimumConfirmations<2))throw new PaymentError('INVALID_CONFIRMATION_POLICY');
  if(evidence.chainId!==BASE_SEPOLIA_CHAIN_ID)throw new PaymentError('RPC_WRONG_NETWORK');
  const {receipt}=evidence;const confirmations=Number(evidence.latestBlock-receipt.blockNumber+1n);
  if(receipt.transactionHash.toLowerCase()!==options.transactionHash.toLowerCase())throw new PaymentError('SETTLEMENT_TRANSACTION_MISMATCH');
  if(receipt.status!=='success'||!Number.isSafeInteger(confirmations)||confirmations<Math.max(2,options.minimumConfirmations??2))throw new PaymentError('SETTLEMENT_PENDING');
  const logs=receipt.logs.filter(log=>sameAddress(log.address,BASE_SEPOLIA_USDC));
  const decoded=parseEventLogs({abi:EVENTS,logs,strict:true});
  const transfer=decoded.find(e=>e.eventName==='Transfer'&&sameAddress(e.args.from,options.metadata.signerAddress)&&sameAddress(e.args.to,options.permit.payTo)&&e.args.value===BigInt(options.permit.amountAtomic));
  const authorization=decoded.find(e=>e.eventName==='AuthorizationUsed'&&sameAddress(e.args.authorizer,options.metadata.signerAddress)&&e.args.nonce===options.permit.nonce);
  if(!transfer||!authorization)throw new PaymentError('SETTLEMENT_EVENTS_MISMATCH');
  return {...options.metadata,network:BASE_SEPOLIA_NETWORK,asset:options.permit.asset,from:options.metadata.signerAddress,to:options.permit.payTo,amountAtomic:options.permit.amountAtomic,transactionHash:options.transactionHash,blockNumber:receipt.blockNumber.toString(),confirmations,authorizationUsed:true};
}
export async function verifyTestnetReceipt(options:TestnetReceiptBinding&{rpcUrl:string}):Promise<VerifiedTestnetSettlement>{
  const rpc=new URL(options.rpcUrl);if(rpc.protocol!=='https:'||rpc.username||rpc.password||rpc.hash)throw new PaymentError('UNSAFE_RPC');
  if(options.minimumConfirmations!==undefined&&(!Number.isSafeInteger(options.minimumConfirmations)||options.minimumConfirmations<2))throw new PaymentError('INVALID_CONFIRMATION_POLICY');
  const client=createPublicClient({chain:baseSepolia,transport:http(options.rpcUrl,{retryCount:0,timeout:10000})});
  const chainId=await client.getChainId();if(chainId!==BASE_SEPOLIA_CHAIN_ID)throw new PaymentError('RPC_WRONG_NETWORK');
  const receipt=await client.getTransactionReceipt({hash:options.transactionHash});
  const latestBlock=await client.getBlockNumber();
  return verifyTestnetReceiptEvidence(options,{chainId,latestBlock,receipt});
}
