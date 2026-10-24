import test from 'node:test';
import assert from 'node:assert/strict';
import {OpenAICompatibleProvider,createProviderFromEnv} from '../src/agents/provider.js';
import {createApp} from '../src/server.js';

// No environment file, real key, external HTTP request or paid model call is used here.
test('incomplete model configuration fails instead of silently selecting deterministic roles',()=>{
  assert.equal(createProviderFromEnv({}).mode,'DETERMINISTIC_SANDBOX');
  for(const env of [{MOTION_LLM_API_KEY:'offline-test-only'},{MOTION_LLM_BASE_URL:'https://model.invalid/v1'},{MOTION_LLM_MODEL:'offline-model'}])assert.throws(()=>createProviderFromEnv(env),/INCOMPLETE_MODEL_CONFIGURATION/);
});

test('a configured live adapter preserves a redacted failure instead of inventing a model result',async()=>{
  const canary='offline-test-response-canary',failures=[
    async()=>new Response(JSON.stringify({message:canary}),{status:503}),
    async()=>new Response(JSON.stringify({choices:[{message:{content:'not-json '+canary}}]}),{status:200}),
    async()=>{throw new Error(canary);},
  ];
  for(const transport of failures){
    let calls=0;const provider=new OpenAICompatibleProvider({baseURL:'https://model.invalid/v1',model:'offline-model',apiKey:'offline-test-only'},async()=>{calls++;return transport();});
    assert.equal(provider.mode,'OPENAI_COMPATIBLE_API','configuration labels the adapter, not evidence of a successful call');
    await assert.rejects(provider.call('worker',{goal:'offline validation'}),(error:unknown)=>{assert.ok(error instanceof Error);assert.equal((error as Error&{code?:string}).code,'MODEL_CHECK_UNAVAILABLE');assert.match(error.message,/^MODEL_CHECK_UNAVAILABLE(?::[A-Z_]+(?::[1-5][0-9]{2})?)?$/);assert.ok(!String(error).includes(canary));assert.ok(!JSON.stringify(error).includes(canary));return true;});assert.equal(calls,1);
  }
});

test('a model configuration does not authorize starting public testnet payments',async()=>{
  await assert.rejects(createApp({executionMode:'TESTNET',operatorToken:'offline-operator-only',authRequired:true}),(error:unknown)=>{
    assert.ok(error instanceof Error);assert.equal((error as Error&{code?:string}).code,'TESTNET_PREFLIGHT_REQUIRED');return true;
  });
});
