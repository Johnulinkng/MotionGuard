import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getAddress, hashTypedData, recoverTypedDataAddress } from 'viem';
import { canonicalJson, sameAddress } from '../payment/canonical.js';
import { assertAsset } from '../payment/policy.js';
import { BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_USDC, PaymentError, USDC_DOMAIN, type AuthorizationCandidate, type Hex, type PaymentRecord, type SignedMetadata, type SigningPermit } from '../payment/types.js';

export const AUTHORIZATION_TYPES = { TransferWithAuthorization: [
  { name:'from',type:'address' },{ name:'to',type:'address' },{ name:'value',type:'uint256' },
  { name:'validAfter',type:'uint256' },{ name:'validBefore',type:'uint256' },{ name:'nonce',type:'bytes32' },
] } as const;
export function transferTypedData(permit: SigningPermit, from: Hex) {
  return {domain:{...USDC_DOMAIN,chainId:BASE_SEPOLIA_CHAIN_ID,verifyingContract:BASE_SEPOLIA_USDC},types:AUTHORIZATION_TYPES,primaryType:'TransferWithAuthorization' as const,
    message:{from:getAddress(from),to:getAddress(permit.payTo),value:BigInt(permit.amountAtomic),validAfter:BigInt(permit.validAfter),validBefore:BigInt(permit.validBefore),nonce:permit.nonce}};
}
export type TransferTypedData = ReturnType<typeof transferTypedData>;
export interface SignedAuthorization { permit: SigningPermit; typedData: TransferTypedData; signature: Hex; metadata: SignedMetadata }
export function validatePermit(permit: SigningPermit, mode: 'MOCK'|'TESTNET', now = Math.floor(Date.now()/1000)): void {
  assertAsset(permit.asset);
  if(permit.executionMode!==mode||!/^0x[\da-f]{64}$/i.test(permit.nonce)||!/^0x[\da-f]{40}$/i.test(permit.payTo)||!/^\d{1,30}$/.test(permit.amountAtomic)||BigInt(permit.amountAtomic)<=0n) throw new PaymentError('INVALID_SIGNING_PERMIT');
  if(!Number.isSafeInteger(permit.validAfter)||!Number.isSafeInteger(permit.validBefore)||permit.validAfter>=now||permit.validBefore<=now||permit.validBefore>now+60) throw new PaymentError('INVALID_SIGNING_WINDOW');
}
/** Returns only address and constrained signTypedData, never the original viem LocalAccount. */
export function createMinimalSigner(privateKey: Hex, permit: SigningPermit, now?:()=>number) {
  const account=privateKeyToAccount(privateKey);
  const expected=transferTypedData(permit,account.address);
  return { address:account.address, async signTypedData(candidate: unknown):Promise<Hex> {
    validatePermit(permit,permit.executionMode,now?.());
    if(canonicalJson(candidate)!==canonicalJson(expected)) throw new PaymentError('TYPED_DATA_NOT_AUTHORIZED');
    return account.signTypedData(expected);
  }};
}
export async function signAuthorization(privateKey: Hex, permit: SigningPermit, now?:()=>number):Promise<SignedAuthorization> {
  const signer=createMinimalSigner(privateKey,permit,now); const typedData=transferTypedData(permit,signer.address);
  const signature=await signer.signTypedData(typedData);
  return {permit:structuredClone(permit),typedData,signature,metadata:{paymentId:permit.paymentId,permitId:permit.permitId,nonce:permit.nonce,validBefore:permit.validBefore,signerAddress:signer.address,authorizationHash:hashTypedData(typedData)}};
}
export async function verifySandboxAuthorization(bundle: SignedAuthorization, now=Math.floor(Date.now()/1000)):Promise<void> {
  validatePermit(bundle.permit,'MOCK',now);
  if(canonicalJson(bundle.typedData)!==canonicalJson(transferTypedData(bundle.permit,bundle.metadata.signerAddress))) throw new PaymentError('SANDBOX_TYPED_DATA_MISMATCH');
  let recovered:string;
  try{recovered=await recoverTypedDataAddress({...bundle.typedData,signature:bundle.signature});}catch{throw new PaymentError('INVALID_CRYPTOGRAPHIC_SIGNATURE');}
  if(!sameAddress(recovered,bundle.metadata.signerAddress)||hashTypedData(bundle.typedData)!==bundle.metadata.authorizationHash) throw new PaymentError('INVALID_CRYPTOGRAPHIC_SIGNATURE');
}
/** Unfunded ephemeral key. Not exported from the signer child to agents, API callers or disk. */
export function ephemeralSandboxKey():Hex { return generatePrivateKey(); }

/** Validate the official SDK's proposed nonce/window and every typed-data field before B issues a permit. */
export function candidateForTestnetPayment(payment:PaymentRecord,from:Hex,candidate:unknown,now=Math.floor(Date.now()/1000)):AuthorizationCandidate{
  if(payment.executionMode!=='TESTNET'||!candidate||typeof candidate!=='object')throw new PaymentError('TESTNET_ONLY');
  const message=(candidate as {message?:unknown}).message;
  if(!message||typeof message!=='object')throw new PaymentError('TYPED_DATA_NOT_AUTHORIZED');
  const fields=message as Record<string,unknown>;
  if(typeof fields.validAfter!=='bigint'||typeof fields.validBefore!=='bigint'||typeof fields.nonce!=='string')throw new PaymentError('TYPED_DATA_NOT_AUTHORIZED');
  const window={nonce:fields.nonce as Hex,validAfter:Number(fields.validAfter),validBefore:Number(fields.validBefore)};
  const permit:SigningPermit={...window,permitId:'candidate_only',paymentId:payment.paymentId,taskId:payment.taskId,authorizationVersion:payment.authorizationVersion,requestHash:payment.requestHash,offerHash:payment.offerHash,asset:payment.asset,payTo:payment.payTo as Hex,amountAtomic:payment.amountAtomic,executionMode:'TESTNET'};
  validatePermit(permit,'TESTNET',now);
  if(window.validBefore>now+payment.maxTimeoutSeconds||canonicalJson(candidate)!==canonicalJson(transferTypedData(permit,from)))throw new PaymentError('TYPED_DATA_NOT_AUTHORIZED');
  return window;
}
