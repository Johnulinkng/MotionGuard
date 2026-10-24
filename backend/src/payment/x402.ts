import { x402Client, wrapFetchWithPayment, x402HTTPClient } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import type { ClientEvmSigner } from '@x402/evm';
import { sameAddress } from './canonical.js';
import { BASE_SEPOLIA_NETWORK, BASE_SEPOLIA_USDC, PaymentError, USDC_DOMAIN, type PaymentRecord } from './types.js';
import { publicOnlyFetch } from './transport-net.js';
import { readLimited } from './transport-body.js';

export interface ThinPayerOptions {
  signer:ClientEvmSigner; payment:Pick<PaymentRecord,'amountAtomic'|'payTo'|'maxTimeoutSeconds'>;
  authorize:()=>Promise<boolean>; afterPayloadCreated?:()=>Promise<void>;
  expectedResourceUrl?:string;
}
/** Official 2.28.0 hook: rejection throws before ExactEvmScheme may call signTypedData. */
export function createThinX402Client(options:ThinPayerOptions):x402Client {
  const client=new x402Client().register(BASE_SEPOLIA_NETWORK,new ExactEvmScheme({address:options.signer.address,signTypedData:m=>options.signer.signTypedData(m)}));
  client.onBeforePaymentCreation(async({selectedRequirements:r,paymentRequired:challenge})=>{
    const method=r.extra?.assetTransferMethod;
    const valid=r.scheme==='exact'&&r.network===BASE_SEPOLIA_NETWORK&&sameAddress(r.asset,BASE_SEPOLIA_USDC)&&sameAddress(r.payTo,options.payment.payTo)&&r.amount===options.payment.amountAtomic&&Number.isSafeInteger(r.maxTimeoutSeconds)&&r.maxTimeoutSeconds>0&&r.maxTimeoutSeconds<=options.payment.maxTimeoutSeconds&&(method===undefined||method==='eip3009')&&r.extra?.name===USDC_DOMAIN.name&&r.extra?.version===USDC_DOMAIN.version;
    if(!valid||challenge.x402Version!==2||Object.keys(challenge.extensions??{}).length>0||(options.expectedResourceUrl!==undefined&&challenge.resource.url!==options.expectedResourceUrl))return {abort:true,reason:'EXACT_QUOTE_NOT_AUTHORIZED'};
    if(await options.authorize()!==true)return {abort:true,reason:'EXPLICIT_ALLOW_REQUIRED'};
  });
  if(options.afterPayloadCreated)client.onAfterPaymentCreation(async()=>{await options.afterPayloadCreated!();});
  return client;
}
export async function payRegisteredTestnetResource(options:ThinPayerOptions&{enabled:true;payment:PaymentRecord;beforeDispatch:()=>Promise<void>;settlementCandidate?:(hash:`0x${string}`)=>Promise<void>;timeoutMs?:number}):Promise<{body:string;transactionHash:`0x${string}`} >{
  if(options.enabled!==true||options.payment.executionMode!=='TESTNET')throw new PaymentError('TESTNET_NOT_ENABLED');
  const url=new URL(options.payment.url);if(url.protocol!=='https:'||url.username||url.password||url.hash)throw new PaymentError('UNSAFE_ROUTE');
  // First testnet adapter supports this fixed registered GET protocol. No model-defined query keys.
  if(options.payment.method!=='GET'||options.payment.body!==undefined)throw new PaymentError('UNSUPPORTED_TESTNET_REQUEST');
  for(const entityId of options.payment.selectors.entityIds??[])url.searchParams.append('entityId',entityId);
  const baseFetch=publicOnlyFetch();let sent=false;
  const bounded:typeof fetch=async(input,init)=>{
    const request=new Request(input,init);
    if(request.url!==url.href||request.method!==options.payment.method)throw new PaymentError('REQUEST_CHANGED');
    if(request.headers.has('PAYMENT-SIGNATURE')){if(sent)throw new PaymentError('SECOND_PAYMENT_FORBIDDEN');await options.beforeDispatch();sent=true;}
    const signal=AbortSignal.timeout(options.timeoutMs??10000);
    const response=await baseFetch(new Request(request,{redirect:'manual',signal}));
    if(response.status>=300&&response.status<400||response.redirected)throw new PaymentError('REDIRECT_FORBIDDEN');
    if(response.status===402){const read=await readLimited(response,64*1024,signal);if(read.failed||read.overflow||read.stopped)throw new PaymentError('CHALLENGE_UNREADABLE');return new Response(read.data.length?new Uint8Array(read.data):null,{status:402,headers:response.headers});}
    return response;
  };
  try{
  const client=createThinX402Client({...options,expectedResourceUrl:url.href});const response=await wrapFetchWithPayment(bounded,client)(url,{method:options.payment.method,headers:{'content-type':'application/json'}});
  const receipt=new x402HTTPClient(client).getPaymentSettleResponse(name=>response.headers.get(name));
  if(!sent||!response.ok||!receipt||receipt.success!==true||typeof receipt.transaction!=='string'||!/^0x[\da-f]{64}$/i.test(receipt.transaction))throw new PaymentError('SETTLEMENT_UNKNOWN');
  await options.settlementCandidate?.(receipt.transaction as `0x${string}`);
  const body=await readLimited(response,256*1024,AbortSignal.timeout(options.timeoutMs??10000));if(body.failed||body.overflow||body.stopped)throw new PaymentError('RESOURCE_BODY_UNREADABLE');
  return {body:body.data.toString('utf8'),transactionHash:receipt.transaction as `0x${string}`};
  }finally{await baseFetch.close();}
}
