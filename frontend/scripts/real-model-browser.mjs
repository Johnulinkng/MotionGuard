import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';

const base = process.env.MOTION_E2E_URL || 'http://127.0.0.1:5173';
const output = resolve('artifacts/real-model/browser');
const goal = process.env.MOTION_REAL_GOAL || '根据授权目录中的真实资料，整理关键数据、资料来源和取得时间，区分原始数据与模型归纳，明确没有覆盖的问题。';
const report = { checkedAt: new Date().toISOString(), layer: 'REAL_BACKEND_CHROME_UI', base, passed: false, goal, chainPaymentVerified: false };
const requests = [];
const failures = [];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
await mkdir(output, { recursive: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
page.on('pageerror', error => failures.push({ kind: 'page', message: error.message }));
page.on('console', message => { if (message.type() === 'error') failures.push({ kind: 'console', message: message.text() }); });
page.on('request', request => {
  const path = new URL(request.url()).pathname;
  if (!path.startsWith('/api/v1/')) return;
  requests.push({ method: request.method(), path, scenario: Boolean(request.headers()['x-mock-scenario']) });
});
const get = async path => {
  const response = await page.request.get(`${base}/api/v1${path}`, { headers: { 'X-Contract-Version': '0.2.0' } });
  assert.equal(response.status(), 200, `GET ${path}`);
  assert.equal(response.headers()['x-contract-version'], '0.2.0');
  return response.json();
};
try {
  await page.goto(base);
  await expect(page.getByRole('button', { name: '新建任务', exact: true })).toBeEnabled();
  const catalog = await get('/catalog');
  report.catalogVersion = catalog.catalogVersion;
  report.catalogVendors = catalog.vendors.map(({ vendorId, name }) => ({ vendorId, name }));
  await page.getByLabel('任务目标预览', { exact: true }).fill(goal);
  await page.getByRole('button', { name: '设置任务与授权', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新建任务', exact: true });
  await expect(form.locator('#scenario')).toHaveCount(0);
  const sourceChoices = form.locator('.form-vendors input[type="checkbox"]');
  await expect(sourceChoices).toHaveCount(catalog.vendors.length);
  for (const checkbox of await sourceChoices.all()) await checkbox.check();
  assert.equal(requests.filter(request => request.method === 'POST').length, 0);
  const createdResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/tasks');
  await form.getByRole('button', { name: '创建并生成计划', exact: true }).click();
  const creation = await createdResponse;
  assert.equal(creation.status(), 201);
  const created = await creation.json();
  report.taskId = created.taskId;
  console.log(JSON.stringify({ createdTaskId: created.taskId, layer: report.layer }));
  await expect(page.getByRole('button', { name: '查看并确认计划', exact: true })).toBeEnabled({ timeout: 20000 });
  const before = await get(`/tasks/${created.taskId}`);
  assert.equal(before.authorization, null);
  const plan = await get(`/tasks/${created.taskId}/resource-plan`);
  report.planHash = plan.planHash;
  await page.getByRole('button', { name: '查看并确认计划', exact: true }).click();
  const authorization = page.getByRole('dialog', { name: '确认资源计划', exact: true });
  await expect(authorization).toContainText(plan.planHash);
  await expect(authorization.getByRole('button', { name: '确认并冻结授权', exact: true })).toBeDisabled();
  await authorization.getByRole('checkbox', { name: '我已核对资源、单价、次数、总额与有效期' }).check();
  await authorization.getByRole('button', { name: '确认并冻结授权', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始执行', exact: true })).toBeEnabled();
  const started = performance.now();
  await page.getByRole('button', { name: '开始执行', exact: true }).click();
  await expect(page.locator('.task-topline')).toContainText(/任务已结束|执行失败|已取消/, { timeout: 180000 });
  report.executionMs = performance.now() - started;
  const finished = await get(`/tasks/${created.taskId}`);
  report.status = finished.status;
  report.summary = finished.summary;
  report.budget = finished.budget;
  const result = await get(`/tasks/${created.taskId}/result`);
  report.result = result;
  assert.equal(finished.status, 'COMPLETED', finished.summary);
  assert.equal(finished.executionMode, 'MOCK', 'Payment mode must remain explicit.');
  assert.equal(result.schemaVersion, '0.2.0');
  assert.equal(result.taskId, created.taskId);
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.model.mode, 'LIVE_API');
  assert.equal(result.dataMode, 'LIVE_HTTP');
  assert.equal(result.learningMode, 'NO_ONLINE_LABELS');
  assert.equal(result.paymentMode, 'MOCK');
  assert.equal(result.paidCalls, 0);
  assert.ok(result.report.trim());
  assert.match(result.report, /\[\d+\]/, 'The actual report must cite its sources.');
  assert.equal(result.sources.length, catalog.vendors.length, 'Every authorized source must be recorded.');
  assert.ok(result.model.diagnostics.length >= 4);
  assert.ok(result.model.diagnostics.every(call => call.status === 'SUCCEEDED' && call.httpStatus === 200));
  for (const role of ['worker', 'threat', 'consistency']) assert.ok(result.model.diagnostics.some(call => call.role === role));
  assert.ok(result.model.diagnostics.some(call => call.role === 'worker' && call.phase === 'report'));
  assert.equal(finished.budget.settledAtomic, '0', 'Free real resources must not generate fake spending.');
  assert.equal(finished.budget.reservedAtomic, '0');
  assert.equal(finished.budget.outstandingAtomic, '0');
  assert.equal(finished.budget.availableAtomic, finished.budget.limitAtomic);
  const payments = await get(`/tasks/${created.taskId}/payments`);
  assert.deepEqual(payments.items, []);
  report.payments = 0;
  await expect(page.getByTestId('task-report')).toHaveText(result.report);
  await expect(page.getByText('资料与模型记录', { exact: true })).toBeVisible({ timeout: 15000 });
  await page.getByText('资料与模型记录', { exact: true }).click();
  await expect(page.locator('.task-evidence-record').first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.task-evidence-loading')).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator('.task-evidence-errors')).toHaveCount(0);
  await page.getByText('资料与模型记录', { exact: true }).click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出公共任务记录', exact: true }).click();
  const download = await downloaded;
  await download.saveAs(resolve(output, 'public-task-export.json'));
  const exported = JSON.parse(await readFile(resolve(output, 'public-task-export.json'), 'utf8'));
  assert.deepEqual(exported.taskResult, result, 'Public export must preserve the complete structured result.');
  report.exportIncludesResult = true;
  await page.screenshot({ path: resolve(output, 'result-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile page overflow');
  await page.screenshot({ path: resolve(output, 'result-mobile.png'), fullPage: true, animations: 'disabled' });
  const beforeReloadMutations = requests.filter(request => request.method === 'POST').length;
  assert.equal(beforeReloadMutations, 4, 'Create, plan, authorize, run are deliberate single requests.');
  await page.reload();
  await expect(page.locator('.task-topline')).toContainText('任务已结束');
  await expect(page.getByText('资料与模型记录', { exact: true })).toBeVisible({ timeout: 15000 });
  assert.equal(requests.filter(request => request.method === 'POST').length, beforeReloadMutations, 'Reload must not repeat mutations or model execution.');
  assert.equal(requests.filter(request => request.scenario).length, 0);
  assert.deepEqual(failures, []);
  report.reloadPosts = 0;
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true, animations: 'disabled' }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  report.requests = requests;
  report.failures = failures;
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    passed: report.passed,
    taskId: report.taskId,
    status: report.status,
    executionMs: report.executionMs,
    sources: report.result?.sources.length,
    modelCalls: report.result?.model.diagnostics.length,
    payments: report.payments,
    reloadPosts: report.reloadPosts,
    error: report.error,
    reportPath: resolve(output, 'report.json'),
  }, null, 2));
  await browser.close();
}
