// Contract-only simulator. No models, wallet keys, signatures, RPC, or remote fetches.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const VERSION='0.2.0';
const FORMAT_VERSION='0.1.0';
const SCENARIOS=new Set(['normal','blocked','review','unknown','lesson']);
const fixture=name=>JSON.parse(readFileSync(new URL(`fixtures/${name}.json`,import.meta.url),'utf8'));
const clone=value=>structuredClone(value);
const now=()=>new Date().toISOString();
const uid=prefix=>`${prefix}_${randomBytes(6).toString('hex')}`;
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?`[${value.map(canonical).join(',')}]`:`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const hash=value=>`sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
const etag=(id,version)=>`"${id}:v${version}"`;
class Fault extends Error{constructor(status,code,message,details){super(message);Object.assign(this,{status,code,details});}}
const fail=(status,code,message,details)=>{throw new Fault(status,code,message,details);};
function exact(body,keys){if(!body||Array.isArray(body)||typeof body!=='object'||Object.keys(body).some(key=>!keys.includes(key)))fail(422,'VALIDATION_ERROR','请求字段与契约不符。');}
function requireMatch(req,current){if(!req.headers['if-match'])fail(428,'PRECONDITION_REQUIRED','需要目标资源的If-Match。');if(req.headers['if-match']!==current)fail(412,'PRECONDITION_FAILED','资源版本已变化，请重新读取快照。',{currentEtag:current});}
async function readBody(req){let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>65536)fail(413,'BODY_TOO_LARGE','请求体超过64KiB。');}try{return JSON.parse(text);}catch{fail(400,'INVALID_JSON','需要有效JSON对象。');}}

export function createMockServer({scenario='normal',history=256,stepMs=60,allowedOrigins=['http://localhost:3000','http://127.0.0.1:3000','http://localhost:5173','http://127.0.0.1:5173']}={}){
  if(!SCENARIOS.has(scenario))throw new Error('Unknown mock scenario');
  const catalog=fixture('catalog'),tasks=new Map(),idem=new Map(),timers=new Set();
  const later=(fn)=>{const timer=setTimeout(()=>{timers.delete(timer);fn();},stepMs);timer.unref();timers.add(timer);};
  function touch(record,type,summary,resourceId=record.task.taskId,resourceType='TASK'){
    const task=record.task;task.version++;task.etag=etag(task.taskId,task.version);task.updatedAt=now();task.budget.version=task.version;task.lastEventSeq++;
    const event={schemaVersion:FORMAT_VERSION,eventId:`${task.taskId}:${task.lastEventSeq}`,taskId:task.taskId,seq:task.lastEventSeq,type,occurredAt:now(),aggregateVersion:task.version,executionMode:'MOCK',summary,resourceId,resourceType};
    record.events.push(event);if(record.events.length>history)record.events.shift();
    for(const res of record.subscribers){if(res.destroyed){record.subscribers.delete(res);continue;}res.write(`id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);}
  }
  function updateBudget(record,settled,reserved,outstanding){const budget=record.task.budget,limit=BigInt(budget.limitAtomic),available=limit-settled-reserved-outstanding;if(available<0n)fail(422,'BUDGET_EXCEEDED','模拟预算不足。');Object.assign(budget,{settledAtomic:String(settled),reservedAtomic:String(reserved),outstandingAtomic:String(outstanding),availableAtomic:String(available)});}
  function finishTask(record,summary){record.task.status='COMPLETED';record.task.summary=summary;touch(record,'task.completed',summary);record.taskResult={schemaVersion:VERSION,taskId:record.task.taskId,status:record.payments.some(p=>p.state==='SETTLED')?'COMPLETED':'BLOCKED',report:`MOCK结果示例：${summary} 本报告仅供界面开发，没有读取真实数据、调用模型或发起真实付款。`,sources:[{evidenceId:record.evidence.evidenceId,url:'https://example.invalid/mock/source',name:'MOCK示例来源（未请求）',observedAt:record.evidence.recordedAt,contentHash:record.evidence.contentHash}],evidenceIds:[record.evidence.evidenceId],model:{mode:'DETERMINISTIC_SANDBOX',diagnostics:[]},dataMode:'SANDBOX',paymentMode:'MOCK',paidCalls:record.payments.filter(p=>p.state==='SETTLED').length,learningMode:'SANDBOX_ORACLE'};}
  function completePayment(record,payment,unknown=false){
    if(record.task.status==='CANCELLED'||record.task.authorization?.status!=='ACTIVE')return;
    const cost=BigInt(payment.amountAtomic),budget=record.task.budget,settled=BigInt(budget.settledAtomic),reserved=BigInt(budget.reservedAtomic),outstanding=BigInt(budget.outstandingAtomic);
    if(BigInt(budget.availableAtomic)<cost){payment.state='REJECTED';payment.decision.type='BLOCK';payment.decision.hardGate='BLOCK';payment.decision.reasonCodes=['BUDGET_EXCEEDED'];touch(record,'payment.updated','MOCK预算拒绝，无真实签名。',payment.paymentId,'PAYMENT');finishTask(record,'MOCK预算拒绝。');return;}
    payment.state='RESERVED';payment.version++;payment.updatedAt=now();updateBudget(record,settled,reserved+cost,outstanding);touch(record,'payment.updated','MOCK预占额度。',payment.paymentId,'PAYMENT');
    payment.state='SIGNED';payment.version++;payment.authorizationStatus='SIMULATED';updateBudget(record,settled,reserved,outstanding+cost);touch(record,'payment.updated','MOCK模拟授权；未产生真实签名。',payment.paymentId,'PAYMENT');
    payment.state='DISPATCHED';payment.version++;touch(record,'payment.updated','MOCK模拟发送；未请求任何商家。',payment.paymentId,'PAYMENT');
    if(unknown){payment.state='UNKNOWN';payment.version++;payment.receipt={status:'UNKNOWN',transactionHash:null,mockReceiptId:uid('mock_unknown'),checkedAt:now()};record.task.status='AWAITING_SETTLEMENT';record.task.summary='MOCK模拟结算未知，额度保持占用；无真实签名或交易。';touch(record,'payment.updated',record.task.summary,payment.paymentId,'PAYMENT');touch(record,'budget.updated','MOCK未确认额度保持占用。',record.task.taskId,'BUDGET');return;}
    payment.state='SETTLED';payment.version++;payment.receipt={status:'SIMULATED',transactionHash:null,mockReceiptId:uid('mock_receipt'),checkedAt:now()};updateBudget(record,settled+cost,reserved,outstanding);touch(record,'payment.updated','MOCK模拟结算；不存在链上交易。',payment.paymentId,'PAYMENT');touch(record,'budget.updated','MOCK资金快照已更新。',record.task.taskId,'BUDGET');
    if(record.scenario==='lesson'){const lesson=fixture('active-lesson');lesson.lessonId=uid('lesson');lesson.sourceEvidenceIds=[record.evidence.evidenceId];lesson.promotion.promotionId=uid('promotion');lesson.promotion.publishedAt=now();record.lessons=[lesson];record.task.activeMemoryVersion=lesson.memoryVersion;touch(record,'lesson.promoted','MOCK展示经验晋升，不代表实际学习实验。',lesson.lessonId,'LESSON');}
    finishTask(record,'MOCK采购流程模拟完成；未创建真实签名或链上交易。');
  }
  function runScenario(record){
    if(record.task.status!=='RUNNING'||record.task.authorization?.status!=='ACTIVE')return;
    const item=record.plan.items[0],vendor=catalog.vendors.find(v=>v.vendorId===item.vendorId),payment=fixture('allowed-payment'),decision=payment.decision,t=now();
    Object.assign(payment,{paymentId:uid('payment'),taskId:record.task.taskId,planItemId:item.itemId,logicalPurchaseId:uid('purchase'),state:'CREATED',version:1,executionMode:'MOCK',authorizationStatus:'NOT_CREATED',vendorId:vendor.vendorId,toolId:vendor.toolId,routeId:vendor.routeId,payTo:vendor.payTo,amountAtomic:item.unitPriceCapAtomic,createdAt:t,updatedAt:t,receipt:{status:'NONE',transactionHash:null,mockReceiptId:null,checkedAt:null}});
    payment.requestHash=hash({taskId:payment.taskId,itemId:item.itemId,purchase:payment.logicalPurchaseId,method:payment.method});payment.offerHash=hash({payTo:payment.payTo,amountAtomic:payment.amountAtomic});
    Object.assign(decision,{decisionId:uid('decision'),taskId:payment.taskId,paymentId:payment.paymentId,requestHash:payment.requestHash,offerHash:payment.offerHash,planHash:record.plan.planHash,authorizationVersion:record.task.authorization.version,evidenceIds:[record.evidence.evidenceId],expiresAt:record.task.authorization.expiresAt});decision.reviewers.forEach(r=>r.evidenceIds=[record.evidence.evidenceId]);record.payments.push(payment);
    if(record.scenario==='blocked'){payment.state='REJECTED';payment.payTo='0x9999999999999999999999999999999999999999';payment.offerHash=hash({payTo:payment.payTo,amountAtomic:payment.amountAtomic});Object.assign(decision,{type:'BLOCK',hardGate:'BLOCK',offerHash:payment.offerHash,reasonCodes:['PAYEE_NOT_AUTHORIZED'],summary:'MOCK：收款方不在冻结计划中，不能通过REVIEW覆盖。'});touch(record,'payment.updated',decision.summary,payment.paymentId,'PAYMENT');finishTask(record,'MOCK攻击被拦截；未创建付款授权。');return;}
    if(record.scenario==='review'){
      Object.assign(decision,{type:'REVIEW',hardGate:'PASS',reasonCodes:['SEMANTIC_UNCERTAINTY'],summary:'MOCK：计划内请求需要用户确认必要性。'});
      const review=fixture('review-required');Object.assign(review,{reviewId:uid('review'),taskId:payment.taskId,paymentId:payment.paymentId,requestHash:payment.requestHash,offerHash:payment.offerHash,planHash:record.plan.planHash,authorizationVersion:record.task.authorization.version,amountAtomic:payment.amountAtomic,payTo:payment.payTo,vendorId:payment.vendorId,createdAt:t,expiresAt:new Date(Math.min(Date.now()+300000,Date.parse(record.task.authorization.expiresAt))).toISOString()});review.snapshotHash=hash({requestHash:review.requestHash,offerHash:review.offerHash,planHash:review.planHash,authorizationVersion:review.authorizationVersion});review.etag=etag(review.reviewId,1);record.reviews.push(review);record.task.status='PAUSED_REVIEW';record.task.pendingReviewCount=1;touch(record,'review.required',review.summary,review.reviewId,'REVIEW');return;
    }
    completePayment(record,payment,record.scenario==='unknown');
  }
  const result=(data,tag,status=200)=>({data:clone(data),etag:tag,status});
  function dispatch(req,path,body){
    const method=req.method;
    if(method==='GET'&&path==='/api/v1/catalog')return result(catalog,etag(catalog.catalogVersion,1));
    if(method==='POST'&&path==='/api/v1/tasks'){
      exact(body,['goal','allowedVendorIds','budgetAtomic','maxPaidCalls','expiresAt']);
      if(typeof body.expiresAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(body.expiresAt))fail(422,'VALIDATION_ERROR','expiresAt必须为UTC ISO 8601时间。');
      if(typeof body.goal!=='string'||!body.goal.trim()||body.goal.length>2000||!Array.isArray(body.allowedVendorIds)||body.allowedVendorIds.length<1||body.allowedVendorIds.length>3||new Set(body.allowedVendorIds).size!==body.allowedVendorIds.length||body.allowedVendorIds.some(v=>!catalog.vendors.some(c=>c.vendorId===v))||typeof body.budgetAtomic!=='string'||!(/^[1-9][0-9]{0,29}$/).test(body.budgetAtomic)||!Number.isInteger(body.maxPaidCalls)||body.maxPaidCalls<1||body.maxPaidCalls>20||typeof body.expiresAt!=='string'||!Number.isFinite(Date.parse(body.expiresAt))||Date.parse(body.expiresAt)<=Date.now())fail(422,'VALIDATION_ERROR','需要有效目标、catalog商家、正整数预算/次数与未来有效期。');
      const selected=req.headers['x-mock-scenario']??scenario;if(!SCENARIOS.has(selected))fail(422,'INVALID_MOCK_SCENARIO','未知模拟场景。');
      const task=fixture('normal-task'),taskId=uid('task'),time=now();Object.assign(task,{taskId,version:1,etag:etag(taskId,1),status:'DRAFT',goal:body.goal,allowedVendorIds:clone(body.allowedVendorIds),planId:null,planHash:null,authorization:null,activeMemoryVersion:'memory_m0',pendingReviewCount:0,lastEventSeq:0,createdAt:time,updatedAt:time,summary:'MOCK草稿；无外部读取、真实签名或付款。'});Object.assign(task.budget,{taskId,limitAtomic:body.budgetAtomic,settledAtomic:'0',reservedAtomic:'0',outstandingAtomic:'0',availableAtomic:body.budgetAtomic,version:1});
      const evidence=fixture('evidence');Object.assign(evidence,{evidenceId:uid('evidence'),taskId,recordedAt:time});
      const record={task,plan:null,body:clone(body),payments:[],reviews:[],lessons:[],evidence,events:[],subscribers:new Set(),scenario:selected};tasks.set(taskId,record);touch(record,'task.created','MOCK任务已创建。');return result(task,task.etag,201);
    }
    const matched=path.match(/^\/api\/v1\/tasks\/([A-Za-z0-9_-]+)(?:\/(.*))?$/);if(!matched)fail(404,'NOT_FOUND','未找到模拟端点。');
    const record=tasks.get(matched[1]);if(!record)fail(404,'TASK_NOT_FOUND','任务不存在。');
    const task=record.task,suffix=matched[2]??'';
    if(method==='GET'){
      if(suffix==='')return result(task,task.etag);
      if(suffix==='resource-plan'){if(!record.plan)fail(409,'PLAN_NOT_READY','计划尚未生成。');return result(record.plan,etag(record.plan.planId,record.plan.version));}
      if(suffix==='budget')return result(task.budget,etag(`budget_${task.taskId}`,task.budget.version));
      if(suffix==='payments')return result({schemaVersion:FORMAT_VERSION,items:record.payments,nextCursor:null},task.etag);
      if(suffix==='reviews')return result({schemaVersion:FORMAT_VERSION,items:record.reviews},task.etag);
      if(suffix==='lessons')return result({schemaVersion:FORMAT_VERSION,items:record.lessons,memoryVersion:task.activeMemoryVersion},task.etag);
      if(suffix==='result'){if(!record.taskResult)fail(409,'RESULT_NOT_READY','报告尚未生成；请读取任务快照并等待。');return result(record.taskResult,`"result_${hash(record.taskResult).slice(7)}"`);}
      const payMatch=suffix.match(/^payments\/([A-Za-z0-9_-]+)(\/decision)?$/);
      if(payMatch){const payment=record.payments.find(p=>p.paymentId===payMatch[1]);if(!payment)fail(404,'PAYMENT_NOT_FOUND','付款不存在。');return payMatch[2]?result(payment.decision,etag(payment.decision.decisionId,1)):result(payment,etag(payment.paymentId,payment.version));}
      const evidenceMatch=suffix.match(/^evidence\/([A-Za-z0-9_-]+)$/);if(evidenceMatch){if(evidenceMatch[1]!==record.evidence.evidenceId)fail(404,'EVIDENCE_NOT_FOUND','证据不存在。');return result(record.evidence,etag(record.evidence.evidenceId,1));}
      fail(404,'NOT_FOUND','未找到模拟端点。');
    }
    if(method!=='POST')fail(404,'NOT_FOUND','未找到模拟端点。');
    const resolve=suffix.match(/^reviews\/([A-Za-z0-9_-]+)\/resolve$/);
    if(resolve){
      exact(body,['choice','snapshotHash']);if(!['APPROVE','REJECT'].includes(body.choice)||typeof body.snapshotHash!=='string')fail(422,'VALIDATION_ERROR','需要choice与snapshotHash。');
      const review=record.reviews.find(r=>r.reviewId===resolve[1]);if(!review)fail(404,'REVIEW_NOT_FOUND','审批不存在。');requireMatch(req,review.etag);
      if(review.status!=='PENDING')fail(409,'STALE_REVIEW','审批已处理或已失效。');if(Date.parse(review.expiresAt)<=Date.now()){review.status='EXPIRED';review.version++;review.etag=etag(review.reviewId,review.version);task.pendingReviewCount=0;touch(record,'review.expired','MOCK审批已过期。',review.reviewId,'REVIEW');fail(409,'REVIEW_EXPIRED','审批已过期。');}
      const payment=record.payments.find(p=>p.paymentId===review.paymentId),item=record.plan.items.find(i=>i.itemId===payment?.planItemId);
      if(body.snapshotHash!==review.snapshotHash||review.planHash!==record.plan.planHash||review.requestHash!==payment?.requestHash||review.offerHash!==payment?.offerHash||task.authorization?.status!=='ACTIVE'||task.authorization.version!==review.authorizationVersion||task.status==='CANCELLED')fail(409,'STALE_REVIEW','请求、计划或授权已改变。');
      if(payment.decision.hardGate==='BLOCK'||!item||payment.vendorId!==item.vendorId||BigInt(payment.amountAtomic)>BigInt(item.unitPriceCapAtomic)||payment.payTo!==catalog.vendors.find(v=>v.vendorId===item.vendorId)?.payTo)fail(422,'HARD_POLICY_BLOCK','REVIEW不能覆盖硬策略或计划边界。');
      if(body.choice==='APPROVE'&&BigInt(task.budget.availableAtomic)<BigInt(payment.amountAtomic))fail(422,'BUDGET_EXCEEDED','预算不足，不生成授权。');
      review.status=body.choice==='APPROVE'?'APPROVED':'REJECTED';review.version++;review.etag=etag(review.reviewId,review.version);review.resolvedAt=now();task.pendingReviewCount=0;task.status=body.choice==='APPROVE'?'RUNNING':'COMPLETED';touch(record,'review.resolved',`MOCK审批${review.status}。`,review.reviewId,'REVIEW');
      if(body.choice==='APPROVE'){payment.decision.type='ALLOW';payment.decision.reasonCodes=['USER_APPROVED_EXACT_SNAPSHOT'];later(()=>completePayment(record,payment));}else{payment.state='REJECTED';payment.decision.type='BLOCK';payment.decision.reasonCodes=['USER_REJECTED'];finishTask(record,'MOCK用户拒绝，未签名。');}
      return result({schemaVersion:FORMAT_VERSION,review,task},review.etag);
    }
    requireMatch(req,task.etag);
    if(suffix==='plan'){
      exact(body,[]);if(task.status!=='DRAFT')fail(409,'INVALID_TASK_STATE','只有DRAFT任务可以初始规划。');task.status='PLANNING';touch(record,'plan.planning','MOCK仅用可信目标与catalog规划；没有外部读取。');later(()=>{if(task.status!=='PLANNING')return;const vendor=catalog.vendors.find(v=>v.vendorId===task.allowedVendorIds[0]),plan=fixture('resource-plan'),cost=BigInt(task.budget.limitAtomic)<10000n?task.budget.limitAtomic:'10000';Object.assign(plan,{planId:uid('plan'),taskId:task.taskId,status:'DRAFT',goalHash:hash(task.goal),catalogVersion:catalog.catalogVersion,totalCapAtomic:task.budget.limitAtomic,expiresAt:record.body.expiresAt,createdAt:now()});Object.assign(plan.items[0],{itemId:uid('item'),goalStepId:'goal_research',toolId:vendor.toolId,vendorId:vendor.vendorId,routeId:vendor.routeId,selectors:{entityIds:[vendor.vendorId]},unitPriceCapAtomic:cost,maxPaidCalls:1,subtotalCapAtomic:cost});plan.planHash=hash({goalHash:plan.goalHash,catalogVersion:plan.catalogVersion,items:plan.items,totalCapAtomic:plan.totalCapAtomic,expiresAt:plan.expiresAt});record.plan=plan;task.planId=plan.planId;task.planHash=plan.planHash;task.status='AWAITING_AUTHORIZATION';touch(record,'plan.ready','MOCK计划待用户确认。',plan.planId,'PLAN');});return result(task,task.etag,202);
    }
    if(suffix==='authorize'){
      exact(body,['planHash']);if(task.status!=='AWAITING_AUTHORIZATION')fail(409,'INVALID_TASK_STATE','任务不处于待授权状态。');if(body.planHash!==record.plan?.planHash)fail(422,'PLAN_MISMATCH','必须确认精确planHash。');if(Date.parse(record.body.expiresAt)<=Date.now())fail(409,'AUTHORIZATION_EXPIRED','计划有效期已过。');
      record.plan.status='FROZEN';record.plan.version++;task.authorization={authorizationId:uid('auth'),version:1,status:'ACTIVE',planHash:record.plan.planHash,goalHash:record.plan.goalHash,catalogVersion:catalog.catalogVersion,budgetAtomic:task.budget.limitAtomic,maxPaidCalls:record.body.maxPaidCalls,expiresAt:record.body.expiresAt,authorizedAt:now(),revokedAt:null};task.status='READY';touch(record,'authorization.frozen','MOCK用户授权与计划已冻结。',task.authorization.authorizationId,'AUTHORIZATION');return result(task,task.etag);
    }
    if(suffix==='runs'){
      exact(body,['authorizationVersion']);if(task.status!=='READY'||task.authorization?.status!=='ACTIVE'||body.authorizationVersion!==task.authorization.version)fail(409,'INVALID_TASK_STATE','需要READY及精确有效授权。');if(Date.parse(task.authorization.expiresAt)<=Date.now())fail(409,'AUTHORIZATION_EXPIRED','授权已过期。');task.status='RUNNING';touch(record,'run.started','MOCK运行开始；不调用真实模型或付款。');later(()=>runScenario(record));return result(task,task.etag,202);
    }
    if(suffix==='cancel'||suffix==='revoke'){
      exact(body,[]);if(suffix==='revoke'&&!task.authorization)fail(409,'NO_AUTHORIZATION','没有可撤销授权。');
      if(suffix==='revoke'){task.authorization.status='REVOKED';task.authorization.version++;task.authorization.revokedAt=now();}
      task.status='CANCELLED';for(const review of record.reviews){if(review.status==='PENDING'){review.status='CANCELLED';review.version++;review.etag=etag(review.reviewId,review.version);review.resolvedAt=now();}}task.pendingReviewCount=0;task.summary='MOCK已停止未来动作；模拟已签未结额度继续占用。';touch(record,suffix==='revoke'?'authorization.revoked':'task.cancelled',task.summary);return result(task,task.etag);
    }
    fail(404,'NOT_FOUND','未找到模拟端点。');
  }
  const server=createServer(async(req,res)=>{
    const origin=req.headers.origin;
    const baseHeaders={'X-Contract-Version':VERSION,'X-Execution-Mode':'MOCK','X-Mock-Auth':'NOT_VALIDATED','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Access-Control-Expose-Headers':'ETag,X-Contract-Version,X-Execution-Mode,X-Mock-Auth,Idempotency-Replayed'};
    if(origin&&allowedOrigins.includes(origin)){baseHeaders['Access-Control-Allow-Origin']=origin;baseHeaders.Vary='Origin';}
    const send=(entry,replayed=false)=>{res.writeHead(entry.status,{...baseHeaders,'Content-Type':'application/json; charset=utf-8',...(entry.etag?{ETag:entry.etag}:{}),...(req.method==='POST'?{'Idempotency-Replayed':String(replayed)}:{})});res.end(JSON.stringify(entry.data));};
    let cacheKey,bodyFingerprint;
    try{
      if(origin&&!allowedOrigins.includes(origin))fail(403,'ORIGIN_NOT_ALLOWED','模拟服务只允许预登记的本机开发Origin。');
      if(req.method==='OPTIONS'){res.writeHead(204,{...baseHeaders,'Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Authorization,Content-Type,X-Contract-Version,Idempotency-Key,If-Match,Last-Event-ID,X-Mock-Scenario'});res.end();return;}
      const url=new URL(req.url,'http://127.0.0.1');if(req.headers['x-contract-version']!==VERSION)fail(400,'CONTRACT_VERSION_REQUIRED',`需要X-Contract-Version: ${VERSION}。`);
      if([...url.searchParams.keys()].some(key=>/token|authorization|key/i.test(key)))fail(400,'TOKEN_IN_URL_FORBIDDEN','不要把凭据放入URL。');
      const stream=url.pathname.match(/^\/api\/v1\/tasks\/([A-Za-z0-9_-]+)\/events$/);
      if(req.method==='GET'&&stream){
        const record=tasks.get(stream[1]);if(!record)fail(404,'TASK_NOT_FOUND','任务不存在。');
        let seq=record.task.lastEventSeq;const cursor=req.headers['last-event-id'];
        if(cursor!==undefined){const parsed=cursor.match(/^([A-Za-z0-9_-]+):([0-9]+)$/);if(!parsed||parsed[1]!==record.task.taskId||!Number.isSafeInteger(Number(parsed[2]))||Number(parsed[2])>record.task.lastEventSeq)fail(400,'INVALID_EVENT_CURSOR','事件游标不属于当前任务或超出范围。');seq=Number(parsed[2]);const earliest=record.events[0]?.seq??1;if(seq<earliest-1)fail(410,'EVENT_CURSOR_EXPIRED','游标已超出保留窗口。',{minEventSeq:earliest,snapshotPath:`/api/v1/tasks/${record.task.taskId}`});}
        res.writeHead(200,{...baseHeaders,'Content-Type':'text/event-stream; charset=utf-8',Connection:'keep-alive'});res.write(': MOCK stream; no real signatures or authentication\n\n');for(const event of record.events.filter(e=>e.seq>seq))res.write(`id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);record.subscribers.add(res);const heartbeat=setInterval(()=>{if(!res.destroyed)res.write(': heartbeat\n\n');},15000);heartbeat.unref();req.on('close',()=>{clearInterval(heartbeat);record.subscribers.delete(res);});return;
      }
      let body;
      if(req.method==='POST'){
        const key=req.headers['idempotency-key'];if(typeof key!=='string'||!(/^[A-Za-z0-9._:-]{8,128}$/).test(key))fail(400,'IDEMPOTENCY_KEY_REQUIRED','需要有效Idempotency-Key。');
        if(!String(req.headers['content-type']??'').toLowerCase().startsWith('application/json'))fail(400,'JSON_CONTENT_TYPE_REQUIRED','POST需要application/json。');
        body=await readBody(req);cacheKey=`mock_operator:${req.method}:${url.pathname}:${key}`;bodyFingerprint=hash(body);const old=idem.get(cacheKey);if(old){if(old.fingerprint!==bodyFingerprint)fail(409,'IDEMPOTENCY_CONFLICT','同一幂等键不能绑定不同请求体。');send(old.result,true);return;}
      }
      const entry=dispatch(req,url.pathname,body);if(cacheKey)idem.set(cacheKey,{fingerprint:bodyFingerprint,result:clone(entry)});send(entry);
    }catch(error){const known=error instanceof Fault,entry={status:known?error.status:500,data:{schemaVersion:FORMAT_VERSION,error:{code:known?error.code:'MOCK_INTERNAL_ERROR',message:known?error.message:'模拟服务内部错误。',requestId:uid('request'),...(known&&error.details?{details:error.details}:{})}}};if(cacheKey&&!idem.has(cacheKey))idem.set(cacheKey,{fingerprint:bodyFingerprint,result:clone(entry)});send(entry);}
  });
  server.on('close',()=>{for(const timer of timers)clearTimeout(timer);for(const record of tasks.values())for(const res of record.subscribers)res.destroy();});
  return server;
}

async function selfCheck(){
  const server=createMockServer({stepMs:5,history:4});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;let assertions=0;
  const expect=(condition,message)=>{assert.ok(condition,message);assertions++;};
  const request=async(path,{method='GET',body,tag,key=uid('idem'),scenario}={})=>{const headers={'X-Contract-Version':VERSION,...(method==='POST'?{'Content-Type':'application/json','Idempotency-Key':key}:{}),...(tag?{'If-Match':tag}:{}),...(scenario?{'X-Mock-Scenario':scenario}:{})};const res=await fetch(base+path,{method,headers,...(method==='POST'?{body:JSON.stringify(body??{})}:{})});const data=await res.json();expect(res.headers.get('x-execution-mode')==='MOCK','mode header');expect(res.headers.get('x-mock-auth')==='NOT_VALIDATED','mock auth warning');return{res,data};};
  const poll=async(id,status)=>{for(let i=0;i<100;i++){const x=await request(`/api/v1/tasks/${id}`);if(x.data.status===status)return x.data;await new Promise(r=>setTimeout(r,5));}throw new Error(`poll timed out: ${status}`);};
  const make=async(scenario)=>{let x=await request('/api/v1/tasks',{method:'POST',scenario,body:{goal:'比较用户指定的供应商',allowedVendorIds:['vendor_alpha'],budgetAtomic:'1000000',maxPaidCalls:3,expiresAt:new Date(Date.now()+3600000).toISOString()}});expect(x.res.status===201,'create');const id=x.data.taskId;const planKey=uid('plan_key');x=await request(`/api/v1/tasks/${id}/plan`,{method:'POST',tag:x.data.etag,key:planKey});expect(x.res.status===202&&x.data.status==='PLANNING','planning');let task=await poll(id,'AWAITING_AUTHORIZATION');const p=await request(`/api/v1/tasks/${id}/resource-plan`);x=await request(`/api/v1/tasks/${id}/authorize`,{method:'POST',tag:task.etag,body:{planHash:p.data.planHash}});expect(x.data.status==='READY','authorize');task=x.data;x=await request(`/api/v1/tasks/${id}/runs`,{method:'POST',tag:task.etag,body:{authorizationVersion:task.authorization.version}});expect(x.res.status===202,'run');return id;};
  try{
    let x=await request('/api/v1/catalog');expect(x.res.status===200&&x.data.vendors.length===3,'catalog');
    x=await request('/api/v1/tasks/task_missing');expect(x.res.status===404,'unknown resource');
    for(const s of ['normal','blocked','review','unknown','lesson']){
      const id=await make(s),task=await poll(id,s==='review'?'PAUSED_REVIEW':s==='unknown'?'AWAITING_SETTLEMENT':'COMPLETED');const list=await request(`/api/v1/tasks/${id}/payments`);const payment=list.data.items[0];expect(payment.executionMode==='MOCK'&&payment.authorizationStatus!=='SIGNED_TESTNET'&&payment.receipt.transactionHash===null,`${s}: no real signature/tx`);
      if(s==='blocked'){expect(payment.state==='REJECTED'&&payment.decision.hardGate==='BLOCK'&&payment.decision.type==='BLOCK','hard block');expect(task.budget.outstandingAtomic==='0'&&task.budget.settledAtomic==='0','blocked no funds');}
      if(s==='unknown'){expect(task.budget.outstandingAtomic==='10000'&&task.budget.availableAtomic==='990000','unknown holds budget');const revoked=await request(`/api/v1/tasks/${id}/revoke`,{method:'POST',tag:task.etag});expect(revoked.data.budget.outstandingAtomic==='10000'&&revoked.data.authorization.status==='REVOKED','revoke keeps exposure');}
      if(s==='review'){const reviews=await request(`/api/v1/tasks/${id}/reviews`),review=reviews.data.items[0],path=`/api/v1/tasks/${id}/reviews/${review.reviewId}/resolve`,key=uid('review_key'),body={choice:'APPROVE',snapshotHash:review.snapshotHash};x=await request(path,{method:'POST',tag:'"wrong:v1"',body});expect(x.res.status===412,'stale ETag');x=await request(path,{method:'POST',tag:review.etag,key,body});expect(x.res.status===200&&x.data.review.status==='APPROVED','approve exact');x=await request(path,{method:'POST',tag:review.etag,key,body});expect(x.res.headers.get('idempotency-replayed')==='true','idempotent approval replay');x=await request(path,{method:'POST',tag:review.etag,key,body:{...body,choice:'REJECT'}});expect(x.res.status===409,'same key changed body conflict');const final=await poll(id,'COMPLETED');expect(final.budget.settledAtomic==='10000','one payment only');}
      if(s==='lesson'){const l=await request(`/api/v1/tasks/${id}/lessons`);expect(l.data.items[0]?.status==='ACTIVE'&&l.data.memoryVersion==='memory_m1','lesson fixture');}
      const cursorRes=await fetch(`${base}/api/v1/tasks/${id}/events`,{headers:{'X-Contract-Version':VERSION,'Last-Event-ID':`${id}:0`}});expect(cursorRes.status===410,'expired replay returns 410');await cursorRes.body.cancel();
    }
    const rejectId=await make('review');await poll(rejectId,'PAUSED_REVIEW');const reviews=await request(`/api/v1/tasks/${rejectId}/reviews`),review=reviews.data.items[0];x=await request(`/api/v1/tasks/${rejectId}/reviews/${review.reviewId}/resolve`,{method:'POST',tag:review.etag,body:{choice:'REJECT',snapshotHash:review.snapshotHash}});expect(x.data.review.status==='REJECTED'&&x.data.task.budget.outstandingAtomic==='0','reject no signing');
    const controller=new AbortController(),snapshot=(await request(`/api/v1/tasks/${rejectId}`)).data,startSeq=snapshot.lastEventSeq;const stream=await fetch(`${base}/api/v1/tasks/${rejectId}/events`,{headers:{'X-Contract-Version':VERSION,'Last-Event-ID':`${rejectId}:${startSeq-1}`},signal:controller.signal});expect(stream.status===200,'SSE replay accepted');const first=await stream.body.getReader().read(),text=new TextDecoder().decode(first.value);expect(text.includes(`id: ${rejectId}:${startSeq}`)&&text.includes('schemaVersion'),'SSE id/JSON event');controller.abort();
    console.log(JSON.stringify({ok:true,executionMode:'MOCK',realSignaturesCreated:0,realTransactionsSent:0,assertions,scenarios:5}));
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===fileURLToPath(new URL(`file:///${process.argv[1].replaceAll('\\','/').replace(/^\//,'')}`))){
  if(process.argv.includes('--check'))await selfCheck();
  else{const args=Object.fromEntries(process.argv.slice(2).filter(a=>a.startsWith('--')&&a.includes('=')).map(a=>a.slice(2).split('=')));const port=Number(args.port??4010);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid port');const server=createMockServer({scenario:args.scenario??'normal'});server.listen(port,'127.0.0.1',()=>console.log(`MOCK ONLY http://127.0.0.1:${port} — no real auth, signatures, remote calls or payments`));}
}
