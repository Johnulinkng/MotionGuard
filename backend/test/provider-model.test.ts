import test from 'node:test';
import assert from 'node:assert/strict';
import {createProviderFromEnv,ModelConfigurationError,ModelProviderError,OpenAICompatibleProvider} from '../src/agents/provider.js';
import type {ProviderCallDiagnostic,ProviderErrorCategory,Role} from '../src/agents/types.js';
const secret='fake_key_never_emit_789';
const configured={MOTION_LLM_BASE_URL:'https://api.deepseek.com',MOTION_LLM_MODEL:'deepseek-flash',MOTION_LLM_API_KEY:secret};
function jsonResponse(output:unknown,extra:Record<string,unknown>={}){return new Response(JSON.stringify({model:'deepseek-flash-response-revision',choices:[{finish_reason:'stop',message:{content:JSON.stringify(output),reasoning_content:'private_reasoning_never_log'}}],...extra}),{status:200,headers:{'Content-Type':'application/json'}});}
function fakeTransport(fn:(input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>Promise<Response>|Response){return fn as typeof fetch;}
function assertSafe(value:unknown){const text=typeof value==='string'?value:JSON.stringify(value);for(const forbidden of [secret,'attack_payload_never_log','private_reasoning_never_log','remote_response_never_log'])assert.ok(!text.includes(forbidden),`diagnostic leaked ${forbidden}`);}

test('DeepSeek uses JSON output, explicit thinking disabled and a small token ceiling; audit records observed model and usage',async()=>{
  let request:any,url:string|undefined;const events:ProviderCallDiagnostic[]=[];
  const provider=new OpenAICompatibleProvider({baseURL:configured.MOTION_LLM_BASE_URL,model:configured.MOTION_LLM_MODEL,apiKey:secret,onDiagnostic:d=>events.push(d)},fakeTransport((input,init)=>{url=String(input);request=JSON.parse(String(init?.body));assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer '+secret);return jsonResponse({verdict:'ALLOW',reasonCode:'PLAN_MATCH'},{usage:{prompt_tokens:211,completion_tokens:24,total_tokens:235,prompt_cache_hit_tokens:128,prompt_cache_miss_tokens:83,completion_tokens_details:{reasoning_tokens:0}}});}));
  const result=await provider.call('threat',{untrustedText:'attack_payload_never_log'});assert.deepEqual(result,{verdict:'ALLOW',reasonCode:'PLAN_MATCH'});assert.equal(url,'https://api.deepseek.com/chat/completions');assert.deepEqual(request.thinking,{type:'disabled'});assert.deepEqual(request.response_format,{type:'json_object'});assert.equal(request.stream,false);assert.equal(request.max_tokens,384);assert.equal(request.reasoning_effort,undefined);assert.match(request.messages[0].content,/JSON/);assert.equal(request.messages[1].content,JSON.stringify({untrustedText:'attack_payload_never_log'}));assert.ok(!JSON.stringify(request).includes(secret));
  const audit=provider.getDiagnostics();assert.equal(audit.length,1);assert.equal(audit[0]?.actualModel,'deepseek-flash-response-revision');assert.equal(audit[0]?.requestedModel,'deepseek-flash');assert.equal(audit[0]?.thinking,'disabled');assert.equal(audit[0]?.httpStatus,200);assert.equal(audit[0]?.status,'SUCCEEDED');assert.equal(audit[0]?.finishReason,'stop');assert.deepEqual(audit[0]?.usage,{promptTokens:211,completionTokens:24,totalTokens:235,promptCacheHitTokens:128,promptCacheMissTokens:83,reasoningTokens:0});assert.ok(audit[0]!.latencyMs>=0);assert.equal(events.length,1);assertSafe(audit);assertSafe(events);
});

test('generic compatible providers omit the DeepSeek-only switch and missing usage/model remain unknown',async()=>{
  let body:any;const provider=new OpenAICompatibleProvider({baseURL:'https://model.example/v1/',model:'compatible-model',apiKey:secret,maxTokens:128},fakeTransport((_input,init)=>{body=JSON.parse(String(init?.body));return new Response(JSON.stringify({choices:[{message:{content:'{"selectedVendorIds":["vendor_alpha"]}'}}]}));}));
  assert.deepEqual(await provider.call('worker',{}),{selectedVendorIds:['vendor_alpha']});assert.equal(body.thinking,undefined);assert.equal(body.max_tokens,128);const audit=provider.getDiagnostics()[0]!;assert.equal(audit.actualModel,undefined);assert.equal(audit.usage,undefined);assert.equal(audit.thinking,'not_requested');
});

test('strict real mode fails startup without full configuration and real failures never select sandbox',async()=>{
  assert.equal(createProviderFromEnv({}).mode,'DETERMINISTIC_SANDBOX');assert.equal(createProviderFromEnv({MOTION_LLM_MODE:'sandbox'}).mode,'DETERMINISTIC_SANDBOX');
  for(const env of [{MOTION_LLM_MODE:'real'},{}])assert.throws(()=>createProviderFromEnv(env,{strictReal:true}),error=>error instanceof ModelConfigurationError&&error.code==='REAL_MODEL_CONFIGURATION_REQUIRED');
  assert.throws(()=>createProviderFromEnv({MOTION_LLM_MODEL:'only-model'}),/INCOMPLETE_MODEL_CONFIGURATION/);assert.throws(()=>createProviderFromEnv({...configured,MOTION_LLM_MODE:'sandbox'}),/CONFLICTING_MODEL_MODE/);assert.throws(()=>createProviderFromEnv({MOTION_LLM_MODE:'typo'}),/INVALID_MODEL_CONFIGURATION/);
  let calls=0;const provider=createProviderFromEnv({...configured,MOTION_LLM_MODE:'real'},{strictReal:true,transport:fakeTransport(()=>{calls++;return new Response('remote_response_never_log '+secret,{status:401});})});assert.equal(provider.mode,'OPENAI_COMPATIBLE_API');await assert.rejects(provider.call('worker',{}),error=>error instanceof ModelProviderError&&error.category==='HTTP_AUTH');assert.equal(provider.mode,'OPENAI_COMPATIBLE_API');assert.equal(calls,1);
});

test('HTTP failures expose only typed category/status, never a remote error body or secret',async()=>{
  const cases:[number,ProviderErrorCategory][]=[[400,'HTTP_REQUEST'],[401,'HTTP_AUTH'],[402,'HTTP_BALANCE'],[403,'HTTP_AUTH'],[422,'HTTP_REQUEST'],[429,'HTTP_RATE_LIMIT'],[500,'HTTP_SERVER'],[503,'HTTP_SERVER'],[302,'HTTP_OTHER']];
  for(const [status,category] of cases){let reads=0;const provider=new OpenAICompatibleProvider({baseURL:configured.MOTION_LLM_BASE_URL,model:'deepseek-flash',apiKey:secret},fakeTransport(()=>{const response=new Response('remote_response_never_log '+secret,{status});const original=response.body!.getReader.bind(response.body);response.body!.getReader=(...args:any[])=>{reads++;return original(...args as []) as any;};return response;}));
    await assert.rejects(provider.call('threat',{text:'attack_payload_never_log'}),error=>{assert.ok(error instanceof ModelProviderError);assert.equal(error.code,'MODEL_CHECK_UNAVAILABLE');assert.equal(error.httpStatus,status);assert.equal(error.category,category);assert.equal(error.diagnostic?.status,'FAILED');assertSafe(String(error));assertSafe(error);assertSafe(error.stack);return true;});assert.equal(reads,0);assertSafe(provider.getDiagnostics());assert.equal(provider.getDiagnostics().length,1);
  }
});

test('network exceptions are sanitized; whole-call timeout aborts even a transport that ignores its signal',async()=>{
  const broken=new OpenAICompatibleProvider({baseURL:configured.MOTION_LLM_BASE_URL,model:'deepseek-flash',apiKey:secret},fakeTransport(()=>{throw new Error('remote_response_never_log '+secret);}));await assert.rejects(broken.call('worker',{}),error=>{assert.ok(error instanceof ModelProviderError);assert.equal(error.category,'NETWORK');assertSafe(error);assertSafe(String(error));return true;});
  let signal:AbortSignal|undefined;const timed=new OpenAICompatibleProvider({baseURL:configured.MOTION_LLM_BASE_URL,model:'deepseek-flash',apiKey:secret,timeoutMs:20},fakeTransport((_input,init)=>{signal=init?.signal??undefined;return new Promise(()=>{});}));const started=Date.now();await assert.rejects(timed.call('worker',{}),error=>error instanceof ModelProviderError&&error.category==='TIMEOUT');assert.ok(Date.now()-started<1000);assert.equal(signal?.aborted,true);assert.equal(timed.getDiagnostics().length,1);assert.equal(timed.getDiagnostics()[0]?.errorCategory,'TIMEOUT');
});

test('empty/malformed/oversized/truncated output and wrong role schemas fail without usable verdicts',async()=>{
  const cases:[Role,Response,ProviderErrorCategory][]=[
    ['worker',new Response('not JSON remote_response_never_log'),'INVALID_RESPONSE'],
    ['worker',new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:''}}]})),'INVALID_OUTPUT'],
    ['worker',jsonResponse({selectedVendorIds:['vendor_alpha']},{choices:[{finish_reason:'length',message:{content:'{"selectedVendorIds":["vendor_alpha"]}'}}]}),'OUTPUT_LIMIT'],
    ['threat',jsonResponse({verdict:'ALLOW',reasonCode:'with spaces'}),'INVALID_OUTPUT'],
    ['worker',jsonResponse({verdict:'ALLOW',reasonCode:'PLAN_MATCH'}),'INVALID_OUTPUT'],
    ['curator',jsonResponse({summary:''}),'INVALID_OUTPUT'],
    ['worker',new Response('x'.repeat(65537)),'INVALID_RESPONSE'],
    ['worker',jsonResponse({selectedVendorIds:['vendor_alpha']},{choices:[{finish_reason:'content_filter',message:{content:'{"selectedVendorIds":["vendor_alpha"]}'}}]}),'INVALID_OUTPUT']
  ];
  for(const [role,response,category] of cases){const provider=new OpenAICompatibleProvider({baseURL:configured.MOTION_LLM_BASE_URL,model:'deepseek-flash',apiKey:secret},fakeTransport(()=>response));await assert.rejects(provider.call(role,{}),error=>error instanceof ModelProviderError&&error.category===category);assertSafe(provider.getDiagnostics());assert.equal(provider.getDiagnostics()[0]?.status,'FAILED');}
});

test('only role fields cross the provider boundary and diagnostics subscriptions cannot change stored metadata or decisions',async()=>{
  const provider=new OpenAICompatibleProvider({baseURL:configured.MOTION_LLM_BASE_URL,model:'deepseek-flash',apiKey:secret},fakeTransport(()=>jsonResponse({verdict:'REVIEW',reasonCode:'UNCONFIRMED_DATE',authorizationVersion:999,payTo:'forged'})));let events=0;
  const unsubscribe=provider.onDiagnostic(d=>{events++;d.requestedModel='mutated';throw new Error(secret);});assert.deepEqual(await provider.call('consistency',{}),{verdict:'REVIEW',reasonCode:'UNCONFIRMED_DATE'});assert.equal(provider.getDiagnostics()[0]?.requestedModel,'deepseek-flash');const copy=provider.getDiagnostics() as ProviderCallDiagnostic[];copy[0]!.requestedModel='also-mutated';assert.equal(provider.getDiagnostics()[0]?.requestedModel,'deepseek-flash');unsubscribe();await provider.call('consistency',{});assert.equal(events,1);assert.equal(provider.getDiagnostics().length,2);
});

test('configuration and unserializable/oversized input errors do not echo sensitive values or call HTTP',async()=>{
  for(const config of [{baseURL:'bad-url-'+secret,model:'deepseek-flash',apiKey:secret},{baseURL:'https://api.deepseek.com?key='+secret,model:'deepseek-flash',apiKey:secret},{baseURL:'https://api.deepseek.com',model:'deepseek-flash',apiKey:secret,timeoutMs:0}])assert.throws(()=>new OpenAICompatibleProvider(config),error=>{assert.ok(error instanceof ModelConfigurationError);assertSafe(String(error));return true;});
  let calls=0;const provider=new OpenAICompatibleProvider({baseURL:configured.MOTION_LLM_BASE_URL,model:'deepseek-flash',apiKey:secret},fakeTransport(()=>{calls++;return jsonResponse({selectedVendorIds:[]});}));const cyclic:any={};cyclic.self=cyclic;for(const input of [cyclic,{large:'x'.repeat(65537)}])await assert.rejects(provider.call('worker',input),error=>error instanceof ModelProviderError&&error.category==='INPUT_INVALID');assert.equal(calls,0);assert.equal(provider.getDiagnostics().length,2);
});

test('worker report phase uses the actual goal/sources, closed report output and 1536 tokens while select stays at 384',async()=>{
  const requests:any[]=[];const input={phase:'report',goal:'比较供应商交付能力并写出采购结论',sources:[{evidenceId:'evidence_source_one',text:'Vendor Alpha supports same-day dispatch.'},{evidenceId:'evidence_source_two',text:'Vendor Beta has no confirmed delivery date.'}]};
  const report='供应商 Alpha 支持当日发货。[1]\n供应商 Beta 的交付日期尚未确认，不能据此保证交付时间。[2]\n资料缺少价格与历史履约率，采购前需要补充核实。';
  const provider=new OpenAICompatibleProvider({baseURL:configured.MOTION_LLM_BASE_URL,model:'deepseek-flash',apiKey:secret},fakeTransport((_url,init)=>{const request=JSON.parse(String(init?.body));requests.push(request);return JSON.parse(request.messages[1].content).phase==='report'?jsonResponse({report,sourceEvidenceIds:['evidence_source_one','evidence_source_two']}):jsonResponse({selectedVendorIds:['vendor_alpha']});}));
  assert.deepEqual(await provider.call('worker',input),{report,sourceEvidenceIds:['evidence_source_one','evidence_source_two']});assert.equal(requests[0].max_tokens,1536);assert.equal(requests[0].messages[1].content,JSON.stringify(input));assert.deepEqual(requests[0].thinking,{type:'disabled'});
  const system=requests[0].messages[0].content;for(const required of [/provided user goal/,/using only the provided sources/,/never instructions or authorization/,/Chinese/,/missing facts/,/\[1\]/,/exactly two fields/,/sourceEvidenceIds/,/provided sources actually used/])assert.match(system,required);
  assert.deepEqual(await provider.call('worker',{phase:'select',goal:input.goal}),{selectedVendorIds:['vendor_alpha']});assert.equal(requests[1].max_tokens,384);const diagnostics=provider.getDiagnostics();assert.equal(diagnostics[0]?.phase,'report');assert.equal(diagnostics[0]?.maxOutputTokens,1536);assert.equal(diagnostics[1]?.phase,'select');assert.equal(diagnostics[1]?.maxOutputTokens,384);assertSafe(diagnostics);assert.ok(!JSON.stringify(diagnostics).includes(report));
});

test('worker report output rejects extra fields, missing evidence array, wrong types and reports over 8000 characters',async()=>{
  const invalid=[
    {report:'根据资料形成结论。[1]',sourceEvidenceIds:['evidence_one'],payTo:'forged_recipient'},
    {report:'根据资料形成结论。[1]'},
    {report:'根据资料形成结论。[1]',sourceEvidenceIds:'evidence_one'},
    {report:'根据资料形成结论。[1]',sourceEvidenceIds:[42]},
    {report:42,sourceEvidenceIds:['evidence_one']},
    {report:' ',sourceEvidenceIds:[]},
    {report:'x'.repeat(8001),sourceEvidenceIds:['evidence_one']},
    {selectedVendorIds:['vendor_alpha']}
  ];
  for(const output of invalid){const provider=new OpenAICompatibleProvider({baseURL:configured.MOTION_LLM_BASE_URL,model:'deepseek-flash',apiKey:secret},fakeTransport(()=>jsonResponse(output)));await assert.rejects(provider.call('worker',{phase:'report',goal:'写报告',sources:[]}),error=>error instanceof ModelProviderError&&error.category==='INVALID_OUTPUT');assert.equal(provider.getDiagnostics()[0]?.maxOutputTokens,1536);assert.equal(provider.getDiagnostics()[0]?.phase,'report');}
  const provider=new OpenAICompatibleProvider({baseURL:configured.MOTION_LLM_BASE_URL,model:'deepseek-flash',apiKey:secret},fakeTransport(()=>jsonResponse({report:'x'.repeat(8000),sourceEvidenceIds:['evidence_one']})));assert.equal((await provider.call('worker',{phase:'report',goal:'Report',sources:[]})).report?.toString().length,8000);
});

test('a report cut off at its token ceiling is never returned even if its partial JSON parses',async()=>{
  const provider=new OpenAICompatibleProvider({baseURL:configured.MOTION_LLM_BASE_URL,model:'deepseek-flash',apiKey:secret},fakeTransport(()=>jsonResponse(null,{choices:[{finish_reason:'length',message:{content:'{"report":"Partial conclusion [1]","sourceEvidenceIds":["evidence_one"]}'}}],usage:{prompt_tokens:100,completion_tokens:1536,total_tokens:1636}})));
  await assert.rejects(provider.call('worker',{phase:'report',goal:'Report',sources:[]}),error=>error instanceof ModelProviderError&&error.category==='OUTPUT_LIMIT');const diagnostic=provider.getDiagnostics()[0]!;assert.equal(diagnostic.phase,'report');assert.equal(diagnostic.maxOutputTokens,1536);assert.equal(diagnostic.finishReason,'length');assert.equal(diagnostic.status,'FAILED');assert.equal(diagnostic.usage?.completionTokens,1536);
});

test('configured API key is rejected before any role output is returned, including escaped JSON and ignored fields',async()=>{
  const cases:[Role,Record<string,unknown>,unknown][]=[
    ['worker',{phase:'report'},{report:'Leaked credential '+secret+' [1]',sourceEvidenceIds:['evidence_one']}],
    ['curator',{}, {summary:'Credential '+secret}],
    ['threat',{}, {verdict:'ALLOW',reasonCode:'PLAN_MATCH',ignored:secret}],
    ['consistency',{}, {verdict:'ALLOW',reasonCode:'PLAN_MATCH',[secret]:'ignored'}],
    ['worker',{phase:'select'},{selectedVendorIds:['vendor_alpha'],ignored:{nested:[secret]}}]
  ];
  for(const [role,input,output] of cases){const events:ProviderCallDiagnostic[]=[];const provider=new OpenAICompatibleProvider({baseURL:configured.MOTION_LLM_BASE_URL,model:'deepseek-flash',apiKey:secret,onDiagnostic:d=>events.push(d)},fakeTransport(()=>jsonResponse(output)));
    await assert.rejects(provider.call(role,input),error=>{assert.ok(error instanceof ModelProviderError);assert.equal(error.category,'INVALID_OUTPUT');assert.equal(error.httpStatus,200);assertSafe(error);assertSafe(String(error));return true;});assert.equal(provider.getDiagnostics()[0]?.status,'FAILED');assert.equal(events.length,1);assertSafe(events);assertSafe(provider.getDiagnostics());
  }
  // JSON escaping must not bypass the check performed on decoded string values.
  const encoded=JSON.stringify({report:'Credential '+secret+' [1]',sourceEvidenceIds:['evidence_one']}).replaceAll(secret,[...secret].map(char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0')).join(''));
  assert.ok(!encoded.includes(secret));const escaped=new OpenAICompatibleProvider({baseURL:configured.MOTION_LLM_BASE_URL,model:'deepseek-flash',apiKey:secret},fakeTransport(()=>jsonResponse(null,{choices:[{finish_reason:'stop',message:{content:encoded}}]})));
  await assert.rejects(escaped.call('worker',{phase:'report'}),error=>error instanceof ModelProviderError&&error.category==='INVALID_OUTPUT');assertSafe(escaped.getDiagnostics());
});

test('normal research about bearer authentication placeholders is accepted without the configured credential',async()=>{
  const report='接口采用 Bearer [REDACTED] 占位符；文档示例使用 sk-example-placeholder，不是本服务凭据。[1]';const provider=new OpenAICompatibleProvider({baseURL:configured.MOTION_LLM_BASE_URL,model:'deepseek-flash',apiKey:secret},fakeTransport(()=>jsonResponse({report,sourceEvidenceIds:['evidence_one']})));
  assert.equal((await provider.call('worker',{phase:'report',sources:[]})).report,report);assert.equal(provider.getDiagnostics()[0]?.status,'SUCCEEDED');
});
