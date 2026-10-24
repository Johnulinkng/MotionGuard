import type { ResourcePlan,Selectors } from '../payment/types.js';

export type RealRouteId='route_base_sepolia'|'route_eth_price'|'route_chain_tvl';
export interface PublicResourceCapability{
  resourceId:string;vendorId:string;name:string;payTo:null;toolId:string;routeId:RealRouteId;resourceKind:'MARKET_DATA';
  description:string;entityIds:readonly string[];toolDescriptorHash:string;
  source:{name:string;url:string;docsUrl:string};
  billing:{kind:'FREE_PUBLIC_DATA';amountAtomic:'0';requiresPayment:false};
}
/** Structural private input; the public schema version is chosen by the contract owner. */
export type ReadResourcePlan=Omit<ResourcePlan,'schemaVersion'> & {schemaVersion:string};
export interface RealResourceRequest{
  plan:ReadResourcePlan;planItemId:string;catalogVersion?:string;routeId?:string;selectors?:Selectors;signal?:AbortSignal;
}
export interface ResourceReadResult{
  resourceId:string;vendorId:string;toolId:string;routeId:RealRouteId;text:string;data:Record<string,unknown>;raw:unknown;
  source:PublicResourceCapability['source'];observedAt:string;sourceTimestamp:string|null;
  contentHash:string;rawContentHash:string;sourceResponseHashes:string[];responseMediaTypes:string[];requestHash:string;responseBytes:number;
  transport:'LIVE_HTTP'|'FIXTURE';billing:PublicResourceCapability['billing'];
}
export class ResourceError extends Error{
  constructor(readonly code:string,message=code){super(message);this.name='ResourceError';}
}
