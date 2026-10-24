import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const source = JSON.parse(await readFile('artifacts/backend-scenarios/report.json', 'utf8'));
const taskId = source.results.find(item => item.name === 'normal')?.taskId;
assert.ok(taskId, 'Run the actual backend scenario checks first.');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const report = { taskId, layer: 'READ_ONLY_BROWSER_VITE_SSE', executionMode: 'MOCK', checkedAt: new Date().toISOString() };
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:5173/');
  Object.assign(report, await page.evaluate(async (id) => {
    const headers = { 'X-Contract-Version': '0.2.0' };
    const beforeResponse = await fetch(`/api/v1/tasks/${id}`, { headers });
    if (!beforeResponse.ok) throw new Error('Could not read the existing task.');
    const before = await beforeResponse.json();
    const cursor = `${id}:${before.lastEventSeq}`;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 8000);
    const started = performance.now();
    let result;
    try {
      const response = await fetch(`/api/v1/tasks/${id}/events`, { headers: { ...headers, 'Last-Event-ID': cursor }, signal: abort.signal });
      const headersAfterMs = performance.now() - started;
      const chunk = await response.body.getReader().read();
      result = { status: response.status, contentType: response.headers.get('content-type'), executionHeader: response.headers.get('X-Execution-Mode'), version: response.headers.get('X-Contract-Version'), headersAfterMs, firstChunkAfterMs: performance.now() - started, firstChunk: new TextDecoder().decode(chunk.value), cursor, beforeSeq: before.lastEventSeq };
    } finally { clearTimeout(timer); abort.abort(); }
    const after = await (await fetch(`/api/v1/tasks/${id}`, { headers })).json();
    return { ...result, afterSeq: after.lastEventSeq };
  }, taskId));
  assert.equal(report.status, 200);
  assert.equal(report.executionHeader, 'MOCK');
  assert.equal(report.version, '0.2.0');
  assert.match(report.contentType, /text\/event-stream/);
  assert.match(report.firstChunk, /^: connected\r?\n\r?\n/);
  assert.equal(report.afterSeq, report.beforeSeq, 'A connection comment must not advance the event cursor.');
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.message; process.exitCode = 1; }
finally {
  await browser.close();
  await mkdir('artifacts/backend-scenarios', { recursive: true });
  await writeFile('artifacts/backend-scenarios/sse-after-fix.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
