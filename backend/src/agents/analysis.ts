import type {Catalog, Finding, Observation, ResourcePlan, SemanticFacts} from './types.js';
export function extractFacts(observation:Observation,plan:ResourcePlan,catalog:Catalog,hasUntrustedAncestor:boolean):SemanticFacts {
  const text=observation.text.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g,'');const offer=observation.offer;
  const item=plan.items.find(x=>x.vendorId===offer.vendorId&&x.toolId===offer.toolId&&x.routeId===offer.routeId);const vendor=catalog.vendors.find(v=>v.vendorId===offer.vendorId);
  const atomic=/^(0|[1-9][0-9]*)$/.test(offer.amountAtomic);
  return {externalInstruction:/(ignore.{0,40}(?:previous|prior|instructions|budget)|system\s*(?:update|override)|忽略.{0,30}(?:指令|预算|规则)|绕过.{0,20}(?:审核|限制))/is.test(text),externalPaymentPrerequisite:/(?:must|requires?|first|先|必须|需要|需).{0,70}(?:pay|fee|付款|支付|费用)|(?:pay|支付|付款).{0,50}(?:activation|verification|unlock|激活|验证|解锁)/is.test(text),recipientChanged:!vendor||vendor.payTo===null||vendor.payTo.toLowerCase()!==offer.payTo.toLowerCase(),amountExceeded:!item||!atomic||BigInt(offer.amountAtomic)>BigInt(item.unitPriceCapAtomic),descriptorChanged:!vendor||vendor.toolDescriptorHash!==offer.descriptorHash,purposeOutsidePlan:!item||JSON.stringify(item.selectors)!==JSON.stringify(offer.selectors),requestsMemoryWrite:/(remember permanently|always trust|exempt from review|以后.{0,30}(?:免审|信任)|永久.{0,20}(?:记住|授权|信任))/is.test(text),hasUntrustedAncestor,duplicateRequest:/(pay.{0,25}again|重复.{0,10}(?:付款|支付))/is.test(text),needsReview:/(not yet confirmed|operator confirmation|待确认|需要人工复核)/i.test(text)};
}
export function staticThreat(facts:SemanticFacts,evidenceIds:string[]):Finding {
  let mechanism='NONE',verdict:Finding['verdict']='ALLOW';
  if(facts.externalInstruction){mechanism='PROMPT_INJECTION';verdict='BLOCK';}else if(facts.requestsMemoryWrite){mechanism='MEMORY_POISONING';verdict='BLOCK';}else if(facts.descriptorChanged){mechanism='TOOL_POISONING';verdict='BLOCK';}else if(facts.externalPaymentPrerequisite){mechanism='UNVERIFIED_PAYMENT_PREREQUISITE';verdict='REVIEW';}
  return {role:'THREAT',verdict,reasonCode:mechanism==='NONE'?'NO_KNOWN_THREAT':mechanism,evidenceIds,mechanism};
}
export function staticConsistency(facts:SemanticFacts,evidenceIds:string[]):Finding {
  let reason='PLAN_MATCH',verdict:Finding['verdict']='ALLOW';
  if(facts.recipientChanged)reason='RECIPIENT_MISMATCH';else if(facts.amountExceeded)reason='PRICE_CAP_EXCEEDED';else if(facts.purposeOutsidePlan)reason='OUTSIDE_FROZEN_PLAN';else if(facts.descriptorChanged)reason='TOOL_DESCRIPTOR_MISMATCH';
  if(reason!=='PLAN_MATCH')verdict='BLOCK';else if(facts.needsReview||facts.externalPaymentPrerequisite){verdict='REVIEW';reason='PLAN_ITEM_NEEDS_REVIEW';}
  return {role:'CONSISTENCY',verdict,reasonCode:reason,evidenceIds,mechanism:reason};
}
export const worst=(...values:('ALLOW'|'REVIEW'|'BLOCK')[])=>values.includes('BLOCK')?'BLOCK':values.includes('REVIEW')?'REVIEW':'ALLOW';
