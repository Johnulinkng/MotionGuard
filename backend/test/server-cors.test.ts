import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
for(const demo of [false,true])test(`separate frontend browser origin preflights with demo controls ${demo}`,async t=>{
  const app=await createApp({dbPath:':memory:',testScenarioHeader:demo});
  await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());
  const address=app.server.address();assert.ok(address&&typeof address==='object');
  const base=`http://127.0.0.1:${address.port}`;
  const response=await fetch(base+'/api/v1/tasks',{method:'OPTIONS',headers:{Origin:'http://127.0.0.1:5173','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type,x-contract-version,idempotency-key,if-match'+(demo?',x-mock-scenario':'')}});
  assert.equal(response.status,204);assert.equal(response.headers.get('access-control-allow-origin'),'http://127.0.0.1:5173');
  assert.equal(response.headers.get('access-control-allow-headers')!.includes('X-Mock-Scenario'),demo);
  const catalog=await fetch(base+'/api/v1/catalog',{headers:{Origin:'http://127.0.0.1:5173','X-Contract-Version':'0.2.0'}});
  assert.equal(catalog.status,200);assert.ok(catalog.headers.get('access-control-expose-headers')!.includes('ETag'));
  const denied=await fetch(base+'/api/v1/tasks',{method:'OPTIONS',headers:{Origin:'https://unknown.invalid','Access-Control-Request-Method':'POST'}});assert.equal(denied.status,403);assert.equal(denied.headers.get('access-control-allow-origin'),null);
});
