import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackendHarness} from '../scripts/contract-check.mjs';
test('idle SSE sends an immediate comment without creating a business event',async t=>{
  const h=await createBackendHarness(t),draft=await h.createDraft(),taskId=draft.data.taskId;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),2000);
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try{
    const response=await fetch(`${h.base}/api/v1/tasks/${taskId}/events`,{headers:{'X-Contract-Version':'0.2.0',Authorization:`Bearer ${h.token}`},signal:controller.signal});
    assert.equal(response.status,200);assert.match(response.headers.get('content-type')!,/^text\/event-stream/);
    reader=response.body!.getReader();const first=await reader.read();assert.equal(first.done,false);
    const text=new TextDecoder().decode(first.value);assert.match(text,/^: connected\n\n/);assert.ok(!text.includes('data:'));
    const current=await h.request('getTask',{params:{taskId}});assert.equal(current.data.lastEventSeq,draft.data.lastEventSeq,'connection comment does not increment the business sequence');
  }finally{clearTimeout(timer);await reader?.cancel();controller.abort();}
});
