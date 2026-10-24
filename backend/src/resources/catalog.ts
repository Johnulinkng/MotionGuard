import { createHash } from 'node:crypto';
import { sha256 } from '../payment/canonical.js';
import { ResourceError,type PublicResourceCapability,type ReadResourcePlan } from './types.js';

export const REAL_RESOURCE_CATALOG_VERSION='public_eth_research_20261024_v1';
const FREE={kind:'FREE_PUBLIC_DATA',amountAtomic:'0',requiresPayment:false} as const;
const definitions=[
  {resourceId:'resource_base_sepolia',vendorId:'vendor_base_public',name:'Base Sepolia 官方公共链状态',payTo:null,toolId:'tool_base_sepolia',routeId:'route_base_sepolia',resourceKind:'MARKET_DATA',description:'免费只读 Base 官方测试网 RPC：验证 chainId 84532，读取最新区块的高度、时间、gas 使用与 base fee；它是测试网数据，不能当 Ethereum 主网活动或付费付款证据。',entityIds:['supplier_base_public'],source:{name:'Base official public RPC',url:'https://sepolia.base.org/',docsUrl:'https://docs.base.org/get-started/connect-to-base'},billing:FREE},
  {resourceId:'resource_eth_price',vendorId:'vendor_llama_price',name:'DefiLlama ETH/USD 公开报价',payTo:null,toolId:'tool_eth_price',routeId:'route_eth_price',resourceKind:'MARKET_DATA',description:'免费无需密钥的 DefiLlama Coins API：读取 coingecko:ethereum 的 ETH/USD 报价与供应方时间戳；它是外部聚合参考数据，不能当成交价或付款确认。',entityIds:['supplier_llama_price'],source:{name:'DefiLlama Coins API',url:'https://coins.llama.fi/prices/current/coingecko:ethereum',docsUrl:'https://api-docs.defillama.com/'},billing:FREE},
  {resourceId:'resource_chain_tvl',vendorId:'vendor_llama_tvl',name:'DefiLlama Ethereum / Base TVL',payTo:null,toolId:'tool_chain_tvl',routeId:'route_chain_tvl',resourceKind:'MARKET_DATA',description:'免费无需密钥的 DefiLlama /v2/chains 聚合：提取 Ethereum 与 Base 的 TVL（USD）。该接口没有供应方快照时间，报告仅标本机观测时间；TVL 不等于交易量、TPS 或 ETH 价格。',entityIds:['supplier_llama_tvl'],source:{name:'DefiLlama chains API',url:'https://api.llama.fi/v2/chains',docsUrl:'https://api-docs.defillama.com/'},billing:FREE},
] as const;
function deepFreeze<T>(value:T):T{if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))deepFreeze(child);}return value;}
export const REAL_RESOURCE_CATALOG:readonly PublicResourceCapability[]=deepFreeze(definitions.map(definition=>({...definition,toolDescriptorHash:sha256(definition)})));
export function getCapability(routeId:string):PublicResourceCapability{
  const capability=REAL_RESOURCE_CATALOG.find(item=>item.routeId===routeId);
  if(!capability)throw new ResourceError('RESOURCE_NOT_ALLOWLISTED');return structuredClone(capability);
}
export function hashReadResourcePlan(plan:ReadResourcePlan):string{
  const {planHash:_hash,status:_status,...immutable}=plan;return sha256(immutable);
}
export function hashResourceText(text:string):string{return `sha256:${createHash('sha256').update(text,'utf8').digest('hex')}`;}
export function validateReadRequest(input:{plan:ReadResourcePlan;planItemId:string;catalogVersion?:string;routeId?:string;selectors?:{entityIds?:string[]}},now:Date){
  const plan=structuredClone(input.plan);
  if(plan.status!=='FROZEN'||plan.planHash!==hashReadResourcePlan(plan)||plan.catalogVersion!==REAL_RESOURCE_CATALOG_VERSION||(input.catalogVersion!==undefined&&input.catalogVersion!==plan.catalogVersion)||!Number.isFinite(Date.parse(plan.expiresAt))||Date.parse(plan.expiresAt)<=now.getTime())throw new ResourceError('FROZEN_READ_PLAN_REQUIRED');
  if(!plan.items.length||plan.items.length>10||new Set(plan.items.map(item=>item.itemId)).size!==plan.items.length)throw new ResourceError('INVALID_READ_PLAN');
  const item=plan.items.find(item=>item.itemId===input.planItemId);if(!item)throw new ResourceError('RESOURCE_NOT_PLANNED');
  const capability=getCapability(item.routeId);
  if(item.vendorId!==capability.vendorId||item.toolId!==capability.toolId||item.resourceKind!==capability.resourceKind||input.routeId!==undefined&&input.routeId!==item.routeId)throw new ResourceError('RESOURCE_PLAN_BINDING_MISMATCH');
  if(item.unitPriceCapAtomic!=='0'||item.subtotalCapAtomic!=='0'||!Number.isSafeInteger(item.maxPaidCalls)||item.maxPaidCalls<0||item.maxPaidCalls>20)throw new ResourceError('FREE_RESOURCE_CANNOT_AUTHORIZE_PAYMENT');
  const selected=structuredClone(input.selectors??item.selectors);
  for(const selection of [item.selectors,selected])if(!selection||typeof selection!=='object'||Array.isArray(selection)||Object.keys(selection).some(key=>key!=='entityIds')||!Array.isArray(selection.entityIds)||selection.entityIds.length<1||selection.entityIds.length>3||selection.entityIds.some(id=>typeof id!=='string'||!capability.entityIds.includes(id))||new Set(selection.entityIds).size!==selection.entityIds.length)throw new ResourceError('INVALID_READ_SELECTORS');
  if(selected.entityIds!.some(id=>!item.selectors.entityIds!.includes(id)))throw new ResourceError('SELECTOR_NOT_AUTHORIZED');
  return {plan,item,capability,selectors:selected,requestHash:sha256({taskId:plan.taskId,planHash:plan.planHash,planItemId:item.itemId,routeId:capability.routeId,url:capability.source.url,selectors:selected})};
}
export function requireConfiguredX402Merchant():never{throw new ResourceError('X402_MERCHANT_UNAVAILABLE','No verified, configured x402 merchant is available. Free public sources do not issue payment offers.');}
