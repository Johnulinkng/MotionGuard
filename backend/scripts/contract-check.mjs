// Independent provider-test support. Uses the published vendor snapshot only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const base=new URL('../',import.meta.url);
const json=path=>JSON.parse(readFileSync(new URL(path,base),'utf8'));
const forbidden=/^(?:privateKey|payerKey|operatorToken|operatorSessionToken|signature|rawSignature|paymentSignature|signedPayload|executionGrant|secret|apiKey|ipcCredential|chainOfThought|hiddenReasoning|databasePath|storagePath)$/i;
export function assertPublicOnly(value,canaries=[]){
  const visit=(v,path='$')=>{if(v&&typeof v==='object')for(const[key,child]of Object.entries(v)){assert.ok(!forbidden.test(key),`private public field ${path}.${key}`);visit(child,`${path}.${key}`);}};visit(value);
  const raw=JSON.stringify(value);for(const canary of canaries)assert.ok(!raw.includes(canary),'secret canary appeared in public response');
}
export function assertExposure(budget){
  for(const field of ['limitAtomic','settledAtomic','reservedAtomic','outstandingAtomic','availableAtomic'])assert.match(budget[field],/^(0|[1-9][0-9]*)$/,field);
  assert.equal(BigInt(budget.settledAtomic)+BigInt(budget.reservedAtomic)+BigInt(budget.outstandingAtomic)+BigInt(budget.availableAtomic),BigInt(budget.limitAtomic),'budget categories must be non-overlapping and sum to limit');
}
export function errorBody(value){assert.ok(value&&typeof value==='object'&&value.error&&typeof value.error.code==='string','expected public ApiError body');return value;}
export async function loadContractChecker(){
  const lock=json('contract.lock.json'),bytes=readFileSync(new URL('vendor/contract/openapi.json',base)),digest=createHash('sha256').update(bytes).digest('hex');
  assert.equal(lock.status,'ready');assert.equal(digest,lock.sha256,'published contract hash drift');
  const api=JSON.parse(bytes),version=api.info.version;
  assert.equal(lock.contract_version,version);
  const [{default:Ajv},{default:addFormats}]=await Promise.all([import('ajv/dist/2020.js'),import('ajv-formats')]);
  const ajv=new Ajv({allErrors:true,strict:false});addFormats(ajv);
  function expand(value,trail=[]){
    if(!value||typeof value!=='object')return value;
    if(value.$ref){assert.ok(value.$ref.startsWith('#/'),'remote refs forbidden in published snapshot');assert.ok(!trail.includes(value.$ref),'unexpected schema cycle');const target=value.$ref.slice(2).split('/').reduce((v,key)=>v?.[key],api);assert.ok(target,`unresolved ${value.$ref}`);return expand(target,[...trail,value.$ref]);}
    if(Array.isArray(value))return value.map(v=>expand(v,trail));
    return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,expand(v,trail)]));
  }
  const schemas=Object.fromEntries(Object.entries(api.components.schemas).map(([name,schema])=>[name,ajv.compile(expand(schema))]));
  const operations=[];
  for(const[path,item]of Object.entries(api.paths))for(const[method,op]of Object.entries(item))if(['get','post','patch','put','delete'].includes(method))operations.push({path,method:method.toUpperCase(),...op});
  assert.equal(operations.length,19,'provider baseline must cover the published 19 operations');
  function checkSchema(name,value){const valid=schemas[name];assert.ok(valid,`unknown schema ${name}`);assert.ok(valid(value),`${name}: ${JSON.stringify(valid.errors)}`);assertPublicOnly(value);if(name==='BudgetView')assertExposure(value);if(value?.budget)assertExposure(value.budget);return value;}
  function header(headers,name){return typeof headers?.get==='function'?headers.get(name):Object.entries(headers??{}).find(([k])=>k.toLowerCase()===name.toLowerCase())?.[1]??null;}
  function checkResponse(operationId,status,headers,body,{canaries=[]}={}){
    const operation=operations.find(o=>o.operationId===operationId);assert.ok(operation,`unknown operation ${operationId}`);
    const response=operation.responses[String(status)]??operation.responses.default;assert.ok(response,`${operationId} undeclared HTTP ${status}`);
    assert.equal(header(headers,'X-Contract-Version'),version,`${operationId} version header`);
    assert.ok(['MOCK','TESTNET'].includes(header(headers,'X-Execution-Mode')),`${operationId} execution mode header`);
    assert.match(header(headers,'Content-Type')??'',/^application\/json(?:;|$)/i,`${operationId} content type`);
    if(status>=200&&status<300){assert.match(header(headers,'ETag')??'',/^"[A-Za-z0-9_:-]+"$/,`${operationId} strong ETag`);if(body?.etag)assert.equal(header(headers,'ETag'),body.etag);}
    const schema=response.content?.['application/json']?.schema;assert.ok(schema,`${operationId} JSON response schema missing`);
    const validate=ajv.compile(expand(schema));assert.ok(validate(body),`${operationId} HTTP ${status}: ${JSON.stringify(validate.errors)}`);
    if(operationId==='resolveReview'&&status>=200&&status<300)assert.equal(header(headers,'ETag'),body.review.etag,'resolveReview ETag must identify the nested review resource');
    assertPublicOnly(body,canaries);if(body?.budget)assertExposure(body.budget);if(operationId==='getBudget'&&status===200)assertExposure(body);
    if(body?.executionMode==='MOCK'&&body?.authorizationStatus){assert.notEqual(body.authorizationStatus,'SIGNED_TESTNET');assert.equal(body.receipt.transactionHash,null);}
    return body;
  }
  function checkEvent(event){checkSchema('EventEnvelope',event);assert.equal(event.eventId,`${event.taskId}:${event.seq}`);return event;}
  return{api,version,operations,schemas,checkSchema,checkResponse,checkEvent};
}

// Starts src/server.ts, never the contract mock. Test state is a private temp DB.
export async function createBackendHarness(t,options={}){
  const checker=await loadContractChecker();
  const temporaryRoot=resolve(tmpdir()),directory=await mkdtemp(join(temporaryRoot,'motion-provider-'));
  const token=`operator-test-canary-${randomUUID()}`;
  const dbPath=join(directory,'state.sqlite');
  const appOptions={dbPath,operatorToken:token,authRequired:true,testScenarioHeader:true,...options};
  let currentApp,base,closed=false;
  const observed=new Set();
  async function open(){const {createApp}=await import('../src/server.ts');currentApp=await createApp(appOptions);assert.ok(currentApp.server&&typeof currentApp.close==='function','createApp must return server and async close');await new Promise((resolveListen,reject)=>{currentApp.server.once('error',reject);currentApp.server.listen(0,'127.0.0.1',resolveListen);});base=`http://127.0.0.1:${currentApp.server.address().port}`;closed=false;}
  async function close(){if(closed)return;closed=true;currentApp.server.closeAllConnections?.();let timer;try{await Promise.race([currentApp.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('backend close exceeded 5 seconds')),5000);timer.unref();})]);assert.equal(currentApp.server.listening,false,'HTTP server still listening after close');}finally{clearTimeout(timer);}}
  await open();
  t.after(async()=>{await close();const target=resolve(directory);assert.ok(target.startsWith(temporaryRoot+sep)&&target.split(sep).at(-1).startsWith('motion-provider-'),'refuse cleanup outside generated temp directory');await rm(target,{recursive:true,force:true,maxRetries:5,retryDelay:30});});
  const endpoint=(operationId,params={})=>{const operation=checker.operations.find(o=>o.operationId===operationId);assert.ok(operation,operationId);return{operation,path:operation.path.replace(/\{([^}]+)\}/g,(_,key)=>{assert.ok(params[key],`missing ${key}`);return encodeURIComponent(params[key]);})};};
  async function request(operationId,{params={},body,ifMatch,idempotencyKey=randomUUID(),auth=true,contractVersion=checker.version,headers={}}={}){
    const {operation,path}=endpoint(operationId,params),requestHeaders={...(contractVersion===null?{}:{'X-Contract-Version':contractVersion}),...(auth===false?{}:{Authorization:`Bearer ${typeof auth==='string'?auth:token}`}),...headers};
    if(operation.method!=='GET'){requestHeaders['Content-Type']='application/json';if(idempotencyKey!==null)requestHeaders['Idempotency-Key']=idempotencyKey;if(ifMatch!==undefined)requestHeaders['If-Match']=ifMatch;}
    const response=await fetch(base+path,{method:operation.method,headers:requestHeaders,...(operation.method==='GET'?{}:{body:JSON.stringify(body??{})})});
    const data=await response.json();checker.checkResponse(operationId,response.status,response.headers,data,{canaries:[token]});observed.add(operationId);return{response,data};
  }
  async function pollTask(taskId,predicate,{timeoutMs=10000}={}){const started=Date.now();let task;while(Date.now()-started<timeoutMs){const result=await request('getTask',{params:{taskId}});assert.equal(result.response.status,200);task=result.data;if(typeof predicate==='string'?task.status===predicate:predicate(task))return task;await new Promise(r=>setTimeout(r,10));}throw new Error(`task ${taskId} did not reach expected state: ${JSON.stringify(task)}`);}
  async function createDraft({scenario='normal',key=randomUUID(),overrides={}}={}){const body={goal:'比较用户指定供应商的交付条件，按冻结资源计划购买资料。',allowedVendorIds:['vendor_alpha'],budgetAtomic:'1000000',maxPaidCalls:3,expiresAt:new Date((options.clock?.()??new Date()).getTime()+3600000).toISOString(),...overrides};const result=await request('createTask',{body,idempotencyKey:key,headers:appOptions.testScenarioHeader?{'X-Mock-Scenario':scenario}:{}});assert.equal(result.response.status,201,JSON.stringify(result.data));return{...result,body,key};}
  async function readyTask({scenario='normal'}={}){let result=await createDraft({scenario});const taskId=result.data.taskId;result=await request('planTask',{params:{taskId},ifMatch:result.data.etag});assert.equal(result.response.status,202);let task=await pollTask(taskId,'AWAITING_AUTHORIZATION');const {data:plan,response:planResponse}=await request('getResourcePlan',{params:{taskId}});assert.equal(planResponse.status,200);result=await request('authorizeTask',{params:{taskId},ifMatch:task.etag,body:{planHash:plan.planHash}});assert.equal(result.response.status,200);task=result.data;assert.equal(task.status,'READY');return{task,plan,taskId};}
  async function startTask({scenario='normal'}={}){const ready=await readyTask({scenario});const result=await request('runTask',{params:{taskId:ready.taskId},ifMatch:ready.task.etag,body:{authorizationVersion:ready.task.authorization.version}});assert.equal(result.response.status,202);return{...ready,run:result.data};}
  async function events(taskId,seq,{timeoutMs=1500,until=()=>false,auth=true}={}){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);timer.unref();const values=[];try{const response=await fetch(`${base}/api/v1/tasks/${taskId}/events`,{headers:{'X-Contract-Version':checker.version,...(auth===false?{}:{Authorization:`Bearer ${token}`}),...(seq===undefined?{}:{'Last-Event-ID':`${taskId}:${seq}`})},signal:controller.signal});observed.add('streamTaskEvents');if(response.status!==200){const data=await response.json();checker.checkResponse('streamTaskEvents',response.status,response.headers,data,{canaries:[token]});return{response,data,events:values};}assert.match(response.headers.get('content-type')??'',/^text\/event-stream/);assert.equal(response.headers.get('x-contract-version'),checker.version);const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';try{while(true){const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true}).replaceAll('\r\n','\n');let boundary;while((boundary=buffer.indexOf('\n\n'))!==-1){const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);const dataLines=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart());if(dataLines.length){const event=JSON.parse(dataLines.join('\n'));checker.checkEvent(event);assertPublicOnly(event,[token]);values.push(event);if(until(event,values)){await reader.cancel();return{response,events:values};}}}}}finally{reader.releaseLock();}return{response,events:values};}catch(error){if(error?.name==='AbortError')return{events:values,aborted:true};throw error;}finally{clearTimeout(timer);controller.abort();}}
  return{checker,token,dbPath,appOptions,observed,request,pollTask,createDraft,readyTask,startTask,events,endpoint,get base(){return base;},get app(){return currentApp;},close,restart:async()=>{await close();await open();}};
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===fileURLToPath(new URL(`file:///${process.argv[1].replaceAll('\\','/').replace(/^\//,'')}`))){
  const checker=await loadContractChecker();
  console.log(JSON.stringify({ok:true,layer:'published-contract-schema-only',contractVersion:checker.version,operations:checker.operations.length,schemas:Object.keys(checker.schemas).length,providerHttpTested:false,chainPaymentTested:false}));
}
