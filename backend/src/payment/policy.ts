import { Ajv2020 } from 'ajv/dist/2020.js';
import { atomic, canonicalJson, hashResourcePlan, sameAddress, sha256, utcSeconds } from './canonical.js';
import { BASE_SEPOLIA_NETWORK, BASE_SEPOLIA_USDC, PaymentError, type Asset, type FrozenAuthorizationInput, type PaymentIntent, type PreparedPaymentIntent, type Selectors } from './types.js';

const ID = /^[A-Za-z][A-Za-z0-9_-]{2,63}$/;
export function assertId(id: string): void { if (typeof id !== 'string' || !ID.test(id)) throw new PaymentError('INVALID_ID'); }
export function assertAsset(asset: Asset): void {
  if (!asset || asset.network !== BASE_SEPOLIA_NETWORK || !sameAddress(asset.tokenAddress, BASE_SEPOLIA_USDC) || asset.symbol !== 'USDC' || asset.decimals !== 6) throw new PaymentError('UNSUPPORTED_ASSET');
}
function selectors(value: Selectors): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => k !== 'entityIds')) throw new PaymentError('INVALID_SELECTORS');
  if (value.entityIds !== undefined && (!Array.isArray(value.entityIds) || value.entityIds.length > 10 || new Set(value.entityIds).size !== value.entityIds.length)) throw new PaymentError('INVALID_SELECTORS');
  value.entityIds?.forEach(assertId);
}
export function validateFrozenAuthorization(input: FrozenAuthorizationInput, now: number): void {
  const { taskId, plan, authorization: auth, catalog, routes } = input;
  assertId(taskId); assertAsset(catalog.asset);
  if (plan.taskId !== taskId || plan.status !== 'FROZEN' || plan.schemaVersion !== '0.1.0' || !plan.items.length || plan.items.length > 10) throw new PaymentError('PLAN_NOT_FROZEN');
  if (plan.planHash !== hashResourcePlan(plan) || auth.planHash !== plan.planHash || auth.goalHash !== plan.goalHash || auth.catalogVersion !== plan.catalogVersion || catalog.catalogVersion !== plan.catalogVersion) throw new PaymentError('PLAN_BINDING_MISMATCH');
  if (auth.status !== 'ACTIVE' || auth.revokedAt !== null || !Number.isSafeInteger(auth.version) || auth.version < 1) throw new PaymentError('INVALID_AUTHORIZATION');
  if (utcSeconds(auth.expiresAt) <= now || utcSeconds(plan.expiresAt) <= now || utcSeconds(auth.expiresAt) > utcSeconds(plan.expiresAt)) throw new PaymentError('AUTHORIZATION_EXPIRED');
  if (atomic(auth.budgetAtomic) <= 0n || atomic(auth.budgetAtomic) > atomic(plan.totalCapAtomic) || !Number.isSafeInteger(auth.maxPaidCalls) || auth.maxPaidCalls < 1 || auth.maxPaidCalls > 20) throw new PaymentError('INVALID_BUDGET');
  const ids = new Set(plan.items.map(i => i.itemId));
  if (ids.size !== plan.items.length) throw new PaymentError('DUPLICATE_PLAN_ITEM');
  let cap = 0n;
  for (const item of plan.items) {
    [item.itemId, item.goalStepId, item.toolId, item.vendorId, item.routeId].forEach(assertId);
    selectors(item.selectors);
    if (!Number.isSafeInteger(item.maxPaidCalls) || item.maxPaidCalls < 1 || item.maxPaidCalls > 20) throw new PaymentError('INVALID_RESOURCE_CAP');
    cap += atomic(item.subtotalCapAtomic);
    if (item.dependsOn.some(d => !ids.has(d) || d === item.itemId) || new Set(item.dependsOn).size !== item.dependsOn.length) throw new PaymentError('INVALID_DEPENDENCY');
    const vendors = catalog.vendors.filter(v => v.vendorId === item.vendorId && v.toolId === item.toolId && v.routeId === item.routeId && v.resourceKind === item.resourceKind);
    const registered = routes.filter(r => r.vendorId === item.vendorId && r.toolId === item.toolId && r.routeId === item.routeId && r.resourceKind === item.resourceKind);
    if (vendors.length !== 1 || registered.length !== 1 || vendors[0]!.toolDescriptorHash !== registered[0]!.toolDescriptorHash) throw new PaymentError('UNREGISTERED_RESOURCE');
    const vendor=vendors[0]!,free=vendor.billing?.kind==='FREE_PUBLIC_DATA'&&vendor.billing.amountAtomic==='0'&&vendor.billing.requiresPayment===false;
    if(free){
      if(vendor.payTo!==null||registered[0]!.payTo!==null||item.unitPriceCapAtomic!=='0'||item.subtotalCapAtomic!=='0'||registered[0]!.method!=='GET')throw new PaymentError('INVALID_FREE_RESOURCE');
    }else if(vendor.payTo===null||registered[0]!.payTo===null||!sameAddress(vendor.payTo,registered[0]!.payTo)||atomic(item.unitPriceCapAtomic)<=0n||atomic(item.subtotalCapAtomic)<=0n)throw new PaymentError('INVALID_RESOURCE_CAP');
    const route = registered[0]!;
    const url = new URL(route.url);
    if (!['sandbox:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || !['GET','POST'].includes(route.method)) throw new PaymentError('UNSAFE_ROUTE');
  }
  if (cap > atomic(plan.totalCapAtomic)) throw new PaymentError('PLAN_CAP_SUM_EXCEEDED');
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): void => { if (visiting.has(id)) throw new PaymentError('DEPENDENCY_CYCLE'); if (visited.has(id)) return; visiting.add(id); plan.items.find(i => i.itemId === id)!.dependsOn.forEach(visit); visiting.delete(id); visited.add(id); };
  ids.forEach(visit);
}
export function preparePayment(input: FrozenAuthorizationInput, intent: PaymentIntent): PreparedPaymentIntent {
  assertId(intent.logicalPurchaseId);
  assertAsset(intent.asset);
  if (intent.taskId !== input.taskId) throw new PaymentError('WRONG_TASK');
  const item = input.plan.items.find(i => i.itemId === intent.planItemId);
  if (!item) throw new PaymentError('RESOURCE_NOT_PLANNED');
  if (['vendorId','toolId','routeId','resourceKind'].some(k => intent[k as keyof PaymentIntent] !== item[k as keyof typeof item])) throw new PaymentError('RESOURCE_BINDING_MISMATCH');
  const route = input.routes.find(r => r.vendorId === item.vendorId && r.toolId === item.toolId && r.routeId === item.routeId)!;
  const vendor=input.catalog.vendors.find(v=>v.vendorId===item.vendorId)!;
  if(vendor.billing?.kind==='FREE_PUBLIC_DATA'||route.payTo===null)throw new PaymentError('FREE_SOURCE_HAS_NO_PAYMENT');
  if (intent.method !== route.method || !sameAddress(intent.payTo, route.payTo)) throw new PaymentError('PAYMENT_ROUTE_MISMATCH');
  const amount = atomic(intent.amountAtomic);
  if (amount <= 0n || amount > atomic(item.unitPriceCapAtomic)) throw new PaymentError('PRICE_CAP_EXCEEDED');
  const selected = structuredClone(intent.selectors ?? item.selectors);
  selectors(selected);
  if ((selected.entityIds ?? []).some(e => !(item.selectors.entityIds ?? []).includes(e))) throw new PaymentError('SELECTOR_NOT_AUTHORIZED');
  if (intent.body !== undefined) {
    if (!route.bodySchema) throw new PaymentError('BODY_NOT_AUTHORIZED');
    const ajv = new Ajv2020({ strict: true, allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false, validateFormats: false });
    if (!ajv.validate(route.bodySchema, intent.body)) throw new PaymentError('BODY_SCHEMA_MISMATCH');
  }
  const lifetime = intent.maxTimeoutSeconds ?? 60;
  if (!Number.isSafeInteger(lifetime) || lifetime < 1 || lifetime > 60) throw new PaymentError('AUTHORIZATION_TOO_LONG');
  const requestHash = sha256({ taskId: intent.taskId, planItemId: intent.planItemId, method: route.method, url: route.url, selectors: selected, body: intent.body ?? null });
  const offerHash = sha256({ scheme: 'exact', assetTransferMethod: 'eip3009', asset: input.catalog.asset, payTo: route.payTo.toLowerCase(), amountAtomic: intent.amountAtomic, maxTimeoutSeconds: lifetime, requestHash });
  if ((intent.requestHash !== undefined && intent.requestHash !== requestHash) || (intent.offerHash !== undefined && intent.offerHash !== offerHash)) throw new PaymentError('REQUEST_COMMITMENT_MISMATCH');
  const prepared = { ...structuredClone(intent), selectors: selected, requestHash, offerHash, maxTimeoutSeconds: lifetime, url: route.url };
  return { ...prepared, intentHash: sha256(prepared) };
}
export function immutableCopy<T>(value: T): T { return JSON.parse(canonicalJson(value)) as T; }
