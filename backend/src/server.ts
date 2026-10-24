import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { MotionService, HttpError, id, type ServiceOptions } from './service.js';
import { CONTRACT_VERSION, validateSchema, assertSchema, contract } from './contracts.js';
import { sha256 } from './payment/canonical.js';
import type { StoredResponse } from './storage.js';
import type * as Public from './generated/contracts.js';

const routes=Object.entries(contract.paths).flatMap(([path,methods])=>Object.entries(methods as Record<string,any>).map(([method,op])=>({method:method.toUpperCase(),path,operation:op.operationId,regex:new RegExp('^'+path.replace(/\{(\w+)\}/g,'(?<$1>[A-Za-z][A-Za-z0-9_-]{2,63})')+'$')})));
function sameSecret(a:string,b:string){const digest=(s:string)=>createHash('sha256').update(s).digest();return timingSafeEqual(digest(a),digest(b));}
async function body(req:IncomingMessage){
  if(!req.headers['content-type']?.toLowerCase().startsWith('application/json'))throw new HttpError(400,'JSON_CONTENT_TYPE_REQUIRED');
  const chunks:Buffer[]=[];let size=0;for await(const part of req){size+=part.length;if(size>262144)throw new HttpError(400,'BODY_TOO_LARGE');chunks.push(part);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new HttpError(400,'INVALID_JSON');}
}
export async function createApp(input:ServiceOptions={}){
  const options:ServiceOptions={...input,authRequired:input.authRequired??!!input.operatorToken};
  if(options.authRequired&&!options.operatorToken)throw new Error('OPERATOR_TOKEN_REQUIRED');
  const service=await MotionService.create(options);
  const owner=sha256({operator:options.operatorToken??'local-mock'});
  function send(res:ServerResponse,result:StoredResponse){assertSchema(result.schema,result.body);res.statusCode=result.status;res.setHeader('Content-Type','application/json; charset=utf-8');for(const[k,v]of Object.entries(result.headers??{}))res.setHeader(k,v);if(result.status<300&&!res.hasHeader('ETag')){const v=result.body as {etag?:string;review?:{etag:string}};res.setHeader('ETag',v?.etag??(result.schema==='ResolveReviewResult'?v.review?.etag:undefined)??`"view_${sha256(result.body).slice(7)}"`);}res.end(JSON.stringify(result.body));}
  const server=createServer(async(req,res)=>{
    res.setHeader('X-Contract-Version',CONTRACT_VERSION);res.setHeader('X-Execution-Mode','MOCK');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    const origin=req.headers.origin;
    if(origin&&(options.allowedOrigins??['http://127.0.0.1:5173','http://localhost:5173']).includes(origin)){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Expose-Headers','ETag,X-Contract-Version,X-Execution-Mode,Idempotency-Replayed');}
    if(req.method==='OPTIONS'){if(origin&&!res.hasHeader('Access-Control-Allow-Origin')){res.statusCode=403;res.end();return;}res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Authorization,Content-Type,X-Contract-Version,Idempotency-Key,If-Match,Last-Event-ID'+(options.testScenarioHeader?',X-Mock-Scenario':''));res.statusCode=204;res.end();return;}
    try{
      if(options.authRequired&&!sameSecret(req.headers.authorization??'',`Bearer ${options.operatorToken}`))throw new HttpError(401,'OPERATOR_SESSION_REQUIRED');
      if(req.headers['x-contract-version']!==CONTRACT_VERSION)throw new HttpError(400,'CONTRACT_VERSION_REQUIRED');
      if(req.headers['x-mock-scenario']&&!options.testScenarioHeader)throw new HttpError(400,'MOCK_CONTROL_DISABLED');
      const url=new URL(req.url??'/','http://localhost');
      const route=routes.find(r=>r.method===req.method&&r.regex.test(url.pathname));if(!route)throw new HttpError(404,'ROUTE_NOT_FOUND');
      const params=route.regex.exec(url.pathname)!.groups??{};const taskId=params.taskId;
      const schemaForRequest:Record<string,string>={createTask:'CreateTask',planTask:'EmptyMutation',authorizeTask:'AuthorizeTask',runTask:'RunTask',cancelTask:'EmptyMutation',revokeTaskAuthorization:'EmptyMutation',resolveReview:'ResolveReview'};
      if(req.method==='POST'){
        const key=req.headers['idempotency-key'];if(typeof key!=='string'||!/^[A-Za-z0-9._:-]{8,128}$/.test(key))throw new HttpError(400,'IDEMPOTENCY_KEY_REQUIRED');
        const value=await body(req);const scope=`${owner}:${url.pathname}`,fingerprint=sha256(value);
        const remembered=service.store.idempotency(scope,key);
        if(remembered){if(remembered.fingerprint!==fingerprint)throw new HttpError(409,'IDEMPOTENCY_CONFLICT');res.setHeader('Idempotency-Replayed','true');send(res,remembered.response);return;}
        if(!validateSchema(schemaForRequest[route.operation],value))throw new HttpError(422,'INVALID_REQUEST');
        const response=service.store.transaction(()=>{
          let t=taskId?service.get(taskId):undefined;
          if(t&&t.owner!==owner)throw new HttpError(403,'TASK_ACCESS_DENIED');
          if(t){const current=route.operation==='resolveReview'?service.review(t,params.reviewId).etag:t.snapshot.etag;const supplied=req.headers['if-match'];if(!supplied)throw new HttpError(428,'IF_MATCH_REQUIRED');if(supplied!==current)throw new HttpError(412,'ETAG_MISMATCH','当前资源版本已变化。',{currentEtag:current});}
          let result:StoredResponse;
          switch(route.operation){
            case 'createTask':{
              const scenario=String(options.testScenarioHeader?req.headers['x-mock-scenario']??options.scenario??'normal':options.scenario??'normal');if(!['normal','blocked','review','unknown','lesson'].includes(scenario))throw new HttpError(422,'UNKNOWN_SCENARIO');
              const created=service.create(value,scenario,owner);result={status:201,schema:'TaskSnapshot',body:created.snapshot};break;
            }
            case 'planTask':service.plan(t!);result={status:202,schema:'TaskSnapshot',body:t!.snapshot};break;
            case 'authorizeTask':service.authorize(t!,value.planHash);result={status:200,schema:'TaskSnapshot',body:t!.snapshot};break;
            case 'runTask':service.run(t!,value.authorizationVersion);result={status:202,schema:'TaskSnapshot',body:t!.snapshot};break;
            case 'cancelTask':service.revoke(t!,true);result={status:200,schema:'TaskSnapshot',body:t!.snapshot};break;
            case 'revokeTaskAuthorization':service.revoke(t!,false);result={status:200,schema:'TaskSnapshot',body:t!.snapshot};break;
            case 'resolveReview':{
              const review=service.review(t!,params.reviewId);const failure=service.resolveReview(t!,review,value.choice,value.snapshotHash);
              result=failure?{status:failure.status,schema:'ApiError',body:{schemaVersion:'0.1.0',error:{code:failure.code,message:failure.message,requestId:id('request')}}}:{status:200,schema:'ResolveReviewResult',headers:{ETag:review.etag},body:{schemaVersion:'0.1.0',review,task:service.get(taskId).snapshot}};break;
            }
            default:throw new HttpError(404,'ROUTE_NOT_FOUND');
          }
          assertSchema(result.schema,result.body);service.store.remember(scope,key,fingerprint,result);return result;
        });
        send(res,response);return;
      }
      const t=taskId?service.get(taskId):undefined;if(t&&t.owner!==owner)throw new HttpError(403,'TASK_ACCESS_DENIED');
      if(route.operation==='streamTaskEvents'){
        const last=req.headers['last-event-id'];let seq=t!.snapshot.lastEventSeq;
        if(last!==undefined){if(typeof last!=='string'||!last.startsWith(`${taskId}:`)||!/^\d+$/.test(last.slice(taskId.length+1)))throw new HttpError(400,'INVALID_EVENT_CURSOR');seq=Number(last.slice(taskId.length+1));if(!Number.isSafeInteger(seq)||seq>t!.snapshot.lastEventSeq)throw new HttpError(400,'INVALID_EVENT_CURSOR');const min=service.store.minSeq(taskId);if(seq<min-1)throw new HttpError(410,'EVENT_CURSOR_EXPIRED','请用任务快照恢复状态。',{minEventSeq:min,snapshotPath:`/api/v1/tasks/${taskId}`});}
        res.statusCode=200;res.setHeader('Content-Type','text/event-stream; charset=utf-8');res.setHeader('Connection','keep-alive');res.flushHeaders();res.write(': connected\n\n');
        const set=service.subscribers.get(taskId)??new Set();set.add(res);service.subscribers.set(taskId,set);
        for(const event of service.store.events(taskId,seq))res.write(`id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        const interval=setInterval(()=>res.write(': heartbeat\n\n'),15000);interval.unref();req.on('close',()=>{clearInterval(interval);set.delete(res);});return;
      }
      let result:StoredResponse;
      const payment=()=>{const p=service.store.get<Public.PaymentView>('payment',params.paymentId,taskId);if(!p)throw new HttpError(404,'PAYMENT_NOT_FOUND');return p;};
      switch(route.operation){
        case 'getCatalog':result={status:200,schema:'Catalog',body:service.catalog};break;
        case 'getTask':service.syncBudget(t!);result={status:200,schema:'TaskSnapshot',body:t!.snapshot};break;
        case 'getTaskResult':result={status:200,schema:'TaskResult',body:service.getTaskResult(t!)};break;
        case 'getResourcePlan':if(!t!.plan)throw new HttpError(404,'PLAN_NOT_FOUND');result={status:200,schema:'ResourcePlan',body:t!.plan};break;
        case 'listPayments':result={status:200,schema:'PaymentList',body:{schemaVersion:'0.1.0',items:service.store.list('payment',taskId),nextCursor:null}};break;
        case 'getPayment':result={status:200,schema:'PaymentView',body:payment()};break;
        case 'getDecision':result={status:200,schema:'DecisionView',body:payment().decision};break;
        case 'getEvidence':{const evidence=service.store.get('evidence',params.evidenceId,taskId);if(!evidence)throw new HttpError(404,'EVIDENCE_NOT_FOUND');result={status:200,schema:'EvidenceSummary',body:evidence};break;}
        case 'getBudget':service.syncBudget(t!);result={status:200,schema:'BudgetView',body:t!.snapshot.budget};break;
        case 'listReviews':result={status:200,schema:'ReviewList',body:{schemaVersion:'0.1.0',items:service.store.list('review',taskId)}};break;
        case 'listLessons':result={status:200,schema:'LessonList',body:{schemaVersion:'0.1.0',items:service.memory.list(),memoryVersion:service.memory.version}};break;
        default:throw new HttpError(404,'ROUTE_NOT_FOUND');
      }
      send(res,result);
    }catch(error){
      const e=error instanceof HttpError?error:new HttpError(500,'INTERNAL_ERROR','服务处理失败；未自动重试付款。');
      // Never echo exception stacks, provider responses, keys or request contents.
      send(res,{status:e.status,schema:'ApiError',body:{schemaVersion:'0.1.0',error:{code:e.code,message:e.message,requestId:id('request'),...(e.details?{details:e.details}:{})}}});
    }
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.maxHeadersCount=80;
  let closed=false;
  return {server,async close(){if(closed)return;closed=true;await service.close();if(server.listening){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}},diagnostics:()=>({backgroundJobs:service.background.size,pendingReviews:service.pending.size,closed:service.closed,agentPid:service.runtime.pid,signerPid:service.kernel.signer.pid})};
}
