import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,join,resolve} from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {validateContract} from './validate-contract.mjs';
import {createMockServer} from './mock-server.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const readJson=async filename=>JSON.parse(await readFile(filename,'utf8'));
const document=await readJson(join(root,'openapi.json'));
async function mutateFixture(file,mutate){
  const target=resolve(root,'fixtures',file);
  return validateContract(root,{readJson:async filename=>{const value=await readJson(filename);if(resolve(filename)===target)mutate(value);return value;}});
}
function normalized(value){if(Array.isArray(value))return value.map(normalized);if(!value||typeof value!=='object')return value;return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,key==='$ref'&&typeof v==='string'?v.replace('#/components/schemas/','#/$defs/'):normalized(v)]));}
const ajv=new Ajv({strict:false,allErrors:true});addFormats(ajv);
const defs=normalized(document.components.schemas),compile=name=>ajv.compile({$defs:defs,$ref:`#/$defs/${name}`});
const resultSchema=compile('TaskResult'),errorSchema=compile('ApiError');

test('0.2 has 19 operations and keeps legacy bodies at format 0.1',async()=>{
  const report=await validateContract(root);assert.equal(report.ok,true,report.errors.join('\n'));assert.equal(report.version,'0.2.0');assert.equal(report.operationCount,19);assert.equal(report.mutationCount,7);
  assert.equal(document.components.schemas.TaskSnapshot.properties.schemaVersion.const,'0.1.0');assert.equal(document.components.schemas.EventEnvelope.properties.schemaVersion.const,'0.1.0');assert.equal(document.components.schemas.ApiError.properties.schemaVersion.const,'0.1.0');assert.equal(document.components.schemas.TaskResult.properties.schemaVersion.const,'0.2.0');
});

for(const [name,file,mutate] of [
  ['paid catalog cannot claim a null recipient without explicit FREE billing','catalog.json',x=>{x.vendors[0].payTo=null;}],
  ['FREE billing cannot advertise a positive price','catalog-free.json',x=>{x.vendors[0].billing.amountAtomic='1';}],
  ['FREE source metadata requires a valid URL','catalog-free.json',x=>{x.vendors[0].source.url='not-a-url';}],
  ['report length is bounded','task-result.json',x=>{x.report='x'.repeat(12001);}],
  ['result cannot expose unknown private fields','task-result.json',x=>{x.rawSignature='forbidden-example';}],
  ['diagnostics cannot expose endpoint or prompt fields','task-result-failed.json',x=>{x.model.diagnostics[0].endpoint='https://example.invalid/private';}],
  ['diagnostics accept only the documented phase enum','task-result-failed.json',x=>{x.model.diagnostics[0].phase='untrusted_phase';}],
  ['token limits are bounded by the provider implementation','task-result-failed.json',x=>{x.model.diagnostics[0].maxOutputTokens=2049;}],
  ['source references must be discoverable in evidenceIds','task-result.json',x=>{x.evidenceIds=[];}],
  ['real HTTP data cannot claim sandbox oracle labels','task-result-failed.json',x=>{x.learningMode='SANDBOX_ORACLE';}],
])test(name,async()=>{const report=await mutateFixture(file,mutate);assert.equal(report.ok,false,'invalid public fixture must be rejected');});

test('read-only result mock uses the 0.2 header, mixed body versions and its own ETag',async t=>{
  const server=createMockServer({stepMs:1});await new Promise(resolveListen=>server.listen(0,'127.0.0.1',resolveListen));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolveClose=>server.close(resolveClose));});
  const base=`http://127.0.0.1:${server.address().port}`;let next=0;
  async function request(path,{body,tag,version='0.2.0'}={}){const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'X-Contract-Version':version,...(body===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':`contract_test_${++next}`}),...(tag?{'If-Match':tag}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await response.json();assert.equal(response.headers.get('x-contract-version'),'0.2.0');assert.equal(response.headers.get('x-execution-mode'),'MOCK');if(response.status>=400){assert.ok(errorSchema(data),JSON.stringify(errorSchema.errors));assert.equal(data.schemaVersion,'0.1.0');}return{response,data};}
  const old=await request('/api/v1/catalog',{version:'0.1.0'});assert.equal(old.response.status,400);
  let x=await request('/api/v1/tasks',{body:{goal:'契约界面模拟',allowedVendorIds:['vendor_alpha'],budgetAtomic:'1000000',maxPaidCalls:1,expiresAt:'2099-01-01T00:00:00.000Z'}});assert.equal(x.response.status,201);assert.equal(x.data.schemaVersion,'0.1.0');const taskId=x.data.taskId;
  const absent=await request(`/api/v1/tasks/${taskId}/result`);assert.equal(absent.response.status,409);assert.equal(absent.data.error.code,'RESULT_NOT_READY');
  await request(`/api/v1/tasks/${taskId}/plan`,{body:{},tag:x.data.etag});
  async function poll(status){for(let i=0;i<100;i++){const x=await request(`/api/v1/tasks/${taskId}`);if(x.data.status===status)return x.data;await new Promise(r=>setTimeout(r,5));}throw new Error(`task did not reach ${status}`);}
  let task=await poll('AWAITING_AUTHORIZATION');const plan=await request(`/api/v1/tasks/${taskId}/resource-plan`);x=await request(`/api/v1/tasks/${taskId}/authorize`,{body:{planHash:plan.data.planHash},tag:task.etag});task=x.data;
  x=await request(`/api/v1/tasks/${taskId}/runs`,{body:{authorizationVersion:task.authorization.version},tag:task.etag});assert.equal(x.response.status,202);await poll('COMPLETED');
  const ready=await request(`/api/v1/tasks/${taskId}/result`);assert.equal(ready.response.status,200);assert.ok(resultSchema(ready.data),JSON.stringify(resultSchema.errors));assert.equal(ready.data.schemaVersion,'0.2.0');assert.equal(ready.data.dataMode,'SANDBOX');assert.equal(ready.data.model.mode,'DETERMINISTIC_SANDBOX');assert.equal(ready.data.paymentMode,'MOCK');assert.match(ready.data.report,/MOCK/);assert.match(ready.response.headers.get('etag'),/^"result_/);
  const replay=await request(`/api/v1/tasks/${taskId}/result`);assert.deepEqual(replay.data,ready.data);assert.equal(replay.response.headers.get('etag'),ready.response.headers.get('etag'));
  const missing=await request('/api/v1/tasks/task_missing/result');assert.equal(missing.response.status,404);
});
