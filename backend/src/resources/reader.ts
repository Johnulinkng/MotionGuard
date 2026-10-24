import { z } from 'zod';
import { publicOnlyFetch } from '../payment/transport-net.js';
import { readLimited } from '../payment/transport-body.js';
import { hashResourceText,validateReadRequest } from './catalog.js';
import { ResourceError,type RealResourceRequest,type ResourceReadResult } from './types.js';
import { createAllowlistedPublicResolver } from './dns.js';

const ALLOWED_ENDPOINTS=new Set(['https://sepolia.base.org/','https://coins.llama.fi/prices/current/coingecko:ethereum','https://api.llama.fi/v2/chains']);
const Quantity=z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]*)$/i);
const Hash=z.string().regex(/^0x[0-9a-f]{64}$/i);
const Block=z.looseObject({number:Quantity,hash:Hash,parentHash:Hash,timestamp:Quantity,gasUsed:Quantity,gasLimit:Quantity,baseFeePerGas:Quantity.optional(),transactions:z.array(Hash).max(4000)});
const Price=z.looseObject({coins:z.record(z.string(),z.unknown())});
const EthQuote=z.looseObject({price:z.number().finite().positive(),symbol:z.literal('ETH'),timestamp:z.number().int().positive(),confidence:z.number().min(0).max(1).optional()});
const Chain=z.looseObject({name:z.enum(['Ethereum','Base']),tvl:z.number().finite().nonnegative(),chainId:z.union([z.number().int(),z.string()]),tokenSymbol:z.string().max(32).nullable().optional()});
const MAX_BYTES=512*1024;
export interface ResourceReaderOptions{
  now?:()=>Date;timeoutMs?:number;
  /** Trusted test seam only. Supplying it labels every result FIXTURE, never LIVE_HTTP. */
  fetch?:typeof globalThis.fetch;
}
function parse<S extends z.ZodType>(schema:S,value:unknown):z.output<S>{const result=schema.safeParse(value);if(!result.success)throw new ResourceError('PUBLIC_SOURCE_SCHEMA_INVALID');return result.data;}
function timeFromSeconds(seconds:number,now:Date):string{
  if(!Number.isSafeInteger(seconds)||seconds<0||seconds>Math.floor(now.getTime()/1000)+300||seconds<Math.floor(now.getTime()/1000)-3600)throw new ResourceError('PUBLIC_SOURCE_STALE');
  return new Date(seconds*1000).toISOString();
}
function gwei(wei:bigint):string{const fractional=(wei%1_000_000_000n).toString().padStart(9,'0').replace(/0+$/,'');return `${wei/1_000_000_000n}${fractional?'.'+fractional:''}`;}
export function createRealResourceReader(options:ResourceReaderOptions={}){
  const now=options.now??(()=>new Date()),timeoutMs=options.timeoutMs??10000;
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<25||timeoutMs>15000)throw new ResourceError('INVALID_RESOURCE_TIMEOUT');
  const owned=options.fetch?undefined:publicOnlyFetch(createAllowlistedPublicResolver());const fetcher=options.fetch??owned!;let closed=false;
  async function requestJson(url:string,signal:AbortSignal,body?:Record<string,unknown>){
    if(closed)throw new ResourceError('RESOURCE_READER_CLOSED');
    if(!ALLOWED_ENDPOINTS.has(url)||new URL(url).protocol!=='https:')throw new ResourceError('RESOURCE_NOT_ALLOWLISTED');
    const response=await fetcher(url,{method:body?'POST':'GET',redirect:'manual',signal,headers:{accept:'application/json',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    if(response.redirected||response.status>=300&&response.status<400){await response.body?.cancel();throw new ResourceError('PUBLIC_SOURCE_REDIRECT_FORBIDDEN');}
    if(response.status===402){await response.body?.cancel();throw new ResourceError('PUBLIC_SOURCE_REQUIRES_PAYMENT','This public source now requires payment. No payment offer is authorized.');}
    if(!response.ok){await response.body?.cancel();throw new ResourceError(response.status===429?'PUBLIC_SOURCE_RATE_LIMITED':'PUBLIC_SOURCE_HTTP_ERROR');}
    const contentType=response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    // This fixed DefiLlama endpoint currently serves JSON as text/html (verified 2026-10-24).
    // It is accepted only here, still JSON-parsed and field-validated; HTML content is never rendered.
    const knownJsonMislabel=url==='https://api.llama.fi/v2/chains'&&contentType==='text/html';
    if(contentType!=='application/json'&&!contentType?.endsWith('+json')&&!knownJsonMislabel){await response.body?.cancel();throw new ResourceError('PUBLIC_SOURCE_CONTENT_TYPE_INVALID');}
    const length=response.headers.get('content-length');if(length!==null&&/^\d+$/.test(length)&&Number(length)>MAX_BYTES){await response.body?.cancel();throw new ResourceError('PUBLIC_SOURCE_RESPONSE_TOO_LARGE');}
    const read=await readLimited(response,MAX_BYTES,signal);
    if(read.stopped)throw new ResourceError('PUBLIC_SOURCE_TIMEOUT');if(read.failed)throw new ResourceError('PUBLIC_SOURCE_BODY_UNREADABLE');if(read.overflow)throw new ResourceError('PUBLIC_SOURCE_RESPONSE_TOO_LARGE');
    const text=read.data.toString('utf8');let data:unknown;try{data=JSON.parse(text);}catch{throw new ResourceError('PUBLIC_SOURCE_JSON_INVALID');}
    return {data,raw:text,bytes:read.data.byteLength,mediaType:contentType??''};
  }
  async function rpc(method:'eth_chainId'|'eth_getBlockByNumber',id:1|2,signal:AbortSignal){
    const body={jsonrpc:'2.0',id,method,params:method==='eth_chainId'?[]:['latest',false]};
    const result=await requestJson('https://sepolia.base.org/',signal,body);
    const envelope=parse(z.looseObject({jsonrpc:z.literal('2.0'),id:z.literal(id),result:z.unknown()}),result.data);
    if(!Object.hasOwn(envelope,'result')||Object.hasOwn(envelope,'error'))throw new ResourceError('PUBLIC_RPC_ERROR');
    return {...result,result:envelope.result};
  }
  async function get(input:RealResourceRequest):Promise<ResourceReadResult>{
    const checked=validateReadRequest(input,now());
    const signal=AbortSignal.any([AbortSignal.timeout(timeoutMs),...(input.signal?[input.signal]:[])]);
    let data:Record<string,unknown>,raw:unknown,sourceResponseHashes:string[],responseMediaTypes:string[],sourceTimestamp:string|null=null,responseBytes=0;
    try{
      if(signal.aborted)throw new ResourceError('PUBLIC_SOURCE_TIMEOUT');
      if(checked.capability.routeId==='route_base_sepolia'){
        const chain=await rpc('eth_chainId',1,signal);if(parse(Quantity,chain.result).toLowerCase()!=='0x14a34')throw new ResourceError('PUBLIC_RPC_WRONG_NETWORK');
        const blockResponse=await rpc('eth_getBlockByNumber',2,signal);const block=parse(Block,blockResponse.result);const gasUsed=BigInt(block.gasUsed),gasLimit=BigInt(block.gasLimit);
        if(gasLimit<=0n||gasUsed>gasLimit)throw new ResourceError('PUBLIC_SOURCE_SCHEMA_INVALID');
        sourceTimestamp=timeFromSeconds(Number(BigInt(block.timestamp)),now());
        data={network:'Base Sepolia testnet',chainId:84532,blockNumber:BigInt(block.number).toString(),blockHash:block.hash,blockTimestamp:sourceTimestamp,gasUsed:gasUsed.toString(),gasLimit:gasLimit.toString(),baseFeePerGasWei:block.baseFeePerGas===undefined?null:BigInt(block.baseFeePerGas).toString(),baseFeeGwei:block.baseFeePerGas===undefined?null:gwei(BigInt(block.baseFeePerGas)),transactionCount:block.transactions.length};
        raw={chainId:{jsonrpc:'2.0',id:1,result:chain.result},block:{jsonrpc:'2.0',id:2,result:{number:block.number,hash:block.hash,parentHash:block.parentHash,timestamp:block.timestamp,gasUsed:block.gasUsed,gasLimit:block.gasLimit,...(block.baseFeePerGas===undefined?{}:{baseFeePerGas:block.baseFeePerGas}),transactions:block.transactions}}};sourceResponseHashes=[hashResourceText(chain.raw),hashResourceText(blockResponse.raw)];responseMediaTypes=[chain.mediaType,blockResponse.mediaType];responseBytes=chain.bytes+blockResponse.bytes;
      }else if(checked.capability.routeId==='route_eth_price'){
        const response=await requestJson(checked.capability.source.url,signal);const payload=parse(Price,response.data);const quote=parse(EthQuote,payload.coins['coingecko:ethereum']);sourceTimestamp=timeFromSeconds(quote.timestamp,now());
        data={asset:'ETH',currency:'USD',price:quote.price,sourceTimestamp,confidence:quote.confidence??null};raw={coins:{'coingecko:ethereum':{price:quote.price,symbol:quote.symbol,timestamp:quote.timestamp,...(quote.confidence===undefined?{}:{confidence:quote.confidence})}}};sourceResponseHashes=[hashResourceText(response.raw)];responseMediaTypes=[response.mediaType];responseBytes=response.bytes;
      }else{
        const response=await requestJson(checked.capability.source.url,signal);const rows=parse(z.array(z.unknown()).max(3000),response.data);
        const selectedNames=['Ethereum','Base'];
        const chains=selectedNames.map(name=>{const matches=rows.filter(row=>row!==null&&typeof row==='object'&&(row as Record<string,unknown>).name===name);if(matches.length!==1)throw new ResourceError('PUBLIC_SOURCE_SCHEMA_INVALID');const chain=parse(Chain,matches[0]);if(String(chain.chainId)!==(name==='Ethereum'?'1':'8453'))throw new ResourceError('PUBLIC_SOURCE_SCHEMA_INVALID');return {name:chain.name,chainId:Number(chain.chainId),tvlUsd:chain.tvl,tokenSymbol:chain.tokenSymbol??null};});
        data={metric:'TVL_USD',chains,sourceTimestamp:null,asOfNotice:'Provider does not include a snapshot timestamp. observedAt is retrieval time, not provider as-of time.'};raw={chains};sourceResponseHashes=[hashResourceText(response.raw)];responseMediaTypes=[response.mediaType];responseBytes=response.bytes;
      }
      const observedAt=now().toISOString();const text=[checked.capability.name,`Source: ${checked.capability.source.name} — ${checked.capability.source.url}`,`Observed at: ${observedAt}`,`Provider as-of: ${sourceTimestamp??'NOT_PROVIDED'}`,`Billing: FREE_PUBLIC_DATA; no payment authorization, signature or settlement`,JSON.stringify(data)].join('\n');
      return {resourceId:checked.capability.resourceId,vendorId:checked.capability.vendorId,toolId:checked.capability.toolId,routeId:checked.capability.routeId,text,data,raw,source:checked.capability.source,observedAt,sourceTimestamp,contentHash:hashResourceText(text),rawContentHash:hashResourceText(JSON.stringify(raw)),sourceResponseHashes,responseMediaTypes,requestHash:checked.requestHash,responseBytes,transport:options.fetch?'FIXTURE':'LIVE_HTTP',billing:checked.capability.billing};
    }catch(error){if(error instanceof ResourceError)throw error;if(signal.aborted)throw new ResourceError('PUBLIC_SOURCE_TIMEOUT');if(error instanceof Error&&error.cause instanceof ResourceError)throw error.cause;throw new ResourceError('PUBLIC_SOURCE_UNAVAILABLE');}
  }
  return {get,async close(){if(closed)return;closed=true;await owned?.close();}};
}
/** One bounded read; no cached/mock/paid fallback. */
export async function getRealResource(input:RealResourceRequest):Promise<ResourceReadResult>{
  const reader=createRealResourceReader();try{return await reader.get(input);}finally{await reader.close();}
}
