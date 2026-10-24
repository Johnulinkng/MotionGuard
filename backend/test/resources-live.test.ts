import test from 'node:test';
import assert from 'node:assert/strict';
import { REAL_RESOURCE_CATALOG,REAL_RESOURCE_CATALOG_VERSION,getRealResource,hashReadResourcePlan,type ReadResourcePlan } from '../src/resources/index.js';

const live=process.env.MOTION_RESOURCES_LIVE==='1';
for(const capability of REAL_RESOURCE_CATALOG)test(`LIVE public read: ${capability.routeId}`,{skip:!live,timeout:15000},async()=>{
  const now=new Date();const p:ReadResourcePlan={schemaVersion:'0.2.0',planId:'plan_live_check',taskId:'task_live_check',version:1,status:'FROZEN',goalHash:`sha256:${'1'.repeat(64)}`,catalogVersion:REAL_RESOURCE_CATALOG_VERSION,planHash:'',items:[{itemId:'item_live',goalStepId:'step_live',resourceKind:capability.resourceKind,toolId:capability.toolId,vendorId:capability.vendorId,routeId:capability.routeId,selectors:{entityIds:[capability.vendorId.replace(/^vendor_/,'supplier_')]},unitPriceCapAtomic:'0',maxPaidCalls:0,subtotalCapAtomic:'0',dependsOn:[],purpose:'Read-only public endpoint verification'}],totalCapAtomic:'0',expiresAt:new Date(now.getTime()+60000).toISOString(),createdAt:now.toISOString()};p.planHash=hashReadResourcePlan(p);
  const result=await getRealResource({plan:p,planItemId:'item_live'});assert.equal(result.transport,'LIVE_HTTP');assert.equal(result.billing.requiresPayment,false);assert.ok(result.responseBytes>0);
  console.log(JSON.stringify({checkedAt:new Date().toISOString(),routeId:result.routeId,source:result.source.url,transport:result.transport,observedAt:result.observedAt,sourceTimestamp:result.sourceTimestamp,responseBytes:result.responseBytes,contentHash:result.contentHash,rawContentHash:result.rawContentHash,data:result.data}));
});
