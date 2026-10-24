import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const baseUrl = process.env.MOTION_E2E_URL || "http://127.0.0.1:5173";
const output = resolve("artifacts/redesign");
const goal = "比较指定供应商的交付条件，购买完成比较所需的资料。";
const requests = [];
const failures = [];
const consoleErrors = [];
const checks = [];
const screenshots = [];
const report = {
  testedAt: new Date().toISOString(),
  target: baseUrl,
  provider: "backend sandbox",
  executionMode: "MOCK",
  chainPaymentVerified: false,
  checks,
  screenshots,
};

function passed(name) {
  checks.push({ name, passed: true });
}

function navigation(page, name) {
  return page
    .getByRole("complementary", { name: "主导航" })
    .getByRole("button", { name, exact: true });
}

function detail(dialog, name) {
  return dialog
    .locator("dt")
    .filter({ hasText: new RegExp(`^${name}$`) })
    .locator("xpath=following-sibling::dd[1]");
}

async function screenshot(page, name) {
  await page.locator(".toast").waitFor({ state: "hidden", timeout: 6_000 });
  await page.evaluate(() => document.fonts.ready);
  const filename = `${name}.png`;
  await page.screenshot({
    path: resolve(output, filename),
    fullPage: true,
    animations: "disabled",
  });
  screenshots.push(filename);
}

async function apiGet(page, path) {
  const response = await page.request.get(`${baseUrl}/api/v1${path}`, {
    headers: { "X-Contract-Version": "0.2.0" },
  });
  expect(response.status()).toBe(200);
  expect(response.headers()["x-execution-mode"]).toBe("MOCK");
  expect(response.headers()["x-contract-version"]).toBe("0.2.0");
  return response.json();
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
let page;
try {
  page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
    deviceScaleFactor: 1,
  });
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/v1")) return;
    requests.push({
      method: request.method(),
      path,
      scenarioHeader: Object.keys(request.headers()).some(
        (name) => name.toLowerCase() === "x-mock-scenario",
      ),
    });
  });
  await page.goto(baseUrl);
  await expect(page.locator(".mock-banner")).toContainText("MOCK");
  await expect(
    page.getByRole("button", { name: "新建任务", exact: true }),
  ).toBeEnabled();
  await apiGet(page, "/catalog");
  passed("catalog is a contract-compatible MOCK backend");

  await page.getByRole("button", { name: /付款检查 每笔请求独立判断/ }).click();
  await expect(page.locator(".trust-explanation")).toContainText(
    "需要人工复核时暂停，硬约束不可覆盖",
  );
  await page.getByRole("button", { name: /原始目标 由你定义任务范围/ }).click();
  await expect(page.locator(".trust-explanation")).toContainText(
    "再选择允许使用的商家和预算",
  );
  await page.getByRole("button", { name: /资源计划 确认后冻结授权/ }).click();
  passed("authorization graph nodes update the explanatory panel");
  await screenshot(page, "overview-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await screenshot(page, "overview-mobile");
  await page.setViewportSize({ width: 1440, height: 1050 });

  await page.getByLabel("任务目标预览", { exact: true }).fill(goal);
  await page
    .getByRole("button", { name: "设置任务与授权", exact: true })
    .click();
  const create = page.getByRole("dialog", { name: "新建任务", exact: true });
  await expect(create.locator("#goal")).toHaveValue(goal);
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(
    0,
  );
  await expect(create.locator("#scenario")).toHaveCount(0);
  passed(
    "overview prefill opens matching goal with no premature mutation or simulator scenario",
  );

  await create.getByLabel("总预算 (USDC)", { exact: true }).fill("1.000001");
  await create.getByLabel("最多付费次数", { exact: true }).fill("3");
  const creation = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/tasks",
  );
  await create
    .getByRole("button", { name: "创建并生成计划", exact: true })
    .click();
  const createdResponse = await creation;
  expect(createdResponse.status()).toBe(201);
  expect(createdResponse.request().postDataJSON()).toMatchObject({
    goal,
    budgetAtomic: "1000001",
    maxPaidCalls: 3,
    allowedVendorIds: ["vendor_alpha"],
  });
  const created = await createdResponse.json();
  report.taskId = created.taskId;
  await expect(
    page.getByRole("button", { name: "查看并确认计划", exact: true }),
  ).toBeEnabled({ timeout: 20_000 });
  const beforeAuthorization = await apiGet(page, `/tasks/${created.taskId}`);
  expect(beforeAuthorization.authorization).toBeNull();
  passed(
    "task creation preserves goal, six-decimal budget and paid-call limit",
  );

  await page
    .getByRole("button", { name: "查看并确认计划", exact: true })
    .click();
  const authorize = page.getByRole("dialog", {
    name: "确认资源计划",
    exact: true,
  });
  const plan = await apiGet(page, `/tasks/${created.taskId}/resource-plan`);
  await expect(authorize).toContainText(plan.planHash);
  await expect(authorize).toContainText("1.000001 USDC");
  await expect(
    authorize.getByRole("button", { name: "确认并冻结授权", exact: true }),
  ).toBeDisabled();
  await authorize
    .getByRole("checkbox", { name: "我已核对资源、单价、次数、总额与有效期" })
    .check();
  const authorizationRequest = page.waitForRequest(
    (request) =>
      request.method() === "POST" && request.url().endsWith("/authorize"),
  );
  await authorize
    .getByRole("button", { name: "确认并冻结授权", exact: true })
    .click();
  expect((await authorizationRequest).postDataJSON()).toEqual({
    planHash: plan.planHash,
  });
  await expect(
    page.getByRole("button", { name: "开始执行", exact: true }),
  ).toBeEnabled();
  passed(
    "resource plan requires explicit consent before exact-hash authorization",
  );

  await page.getByRole("button", { name: "开始执行", exact: true }).click();
  await expect(page.locator(".task-topline")).toContainText("任务已结束", {
    timeout: 25_000,
  });
  const finished = await apiGet(page, `/tasks/${created.taskId}`);
  expect(finished.status).toBe("COMPLETED");
  expect(finished.executionMode).toBe("MOCK");
  const budget = finished.budget;
  expect(
    BigInt(budget.settledAtomic) +
      BigInt(budget.reservedAtomic) +
      BigInt(budget.outstandingAtomic) +
      BigInt(budget.availableAtomic),
  ).toBe(BigInt(budget.limitAtomic));
  expect(budget.limitAtomic).toBe("1000001");
  report.finalStatus = finished.status;
  report.budget = budget;
  passed("UI execution completes with conserved exact budget");
  await screenshot(page, "task-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await screenshot(page, "task-mobile");
  await page.setViewportSize({ width: 1440, height: 1050 });

  await navigation(page, "付款记录").click();
  const payments = await apiGet(page, `/tasks/${created.taskId}/payments`);
  expect(payments.items.length).toBeGreaterThan(0);
  for (const payment of payments.items) {
    expect(payment.executionMode).toBe("MOCK");
    expect(payment.authorizationStatus).toBe("SIMULATED");
    expect(payment.receipt.status).toBe("SIMULATED");
    expect(payment.receipt.transactionHash).toBeNull();
  }
  report.paymentCount = payments.items.length;
  const payment = payments.items[0];
  await page
    .getByRole("button", { name: `查看付款 ${payment.paymentId}`, exact: true })
    .click();
  const paymentDialog = page.getByRole("dialog", {
    name: "付款与判定详情",
    exact: true,
  });
  await expect(detail(paymentDialog, "执行模式")).toHaveText("MOCK");
  await expect(detail(paymentDialog, "授权状态")).toHaveText("SIMULATED");
  await expect(detail(paymentDialog, "回执状态")).toHaveText("SIMULATED");
  await expect(detail(paymentDialog, "交易哈希")).toHaveText("无链上交易哈希");
  passed(
    "payment details retain MOCK, simulated authorization/receipt and null chain hash",
  );
  await screenshot(page, "payment-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await screenshot(page, "payment-mobile");

  expect(requests.some((request) => request.scenarioHeader)).toBe(false);
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(
    4,
  );
  expect(failures).toEqual([]);
  expect(consoleErrors).toEqual([]);
  passed(
    "all browser API requests omit X-Mock-Scenario; only four deliberate mutations occur",
  );
  passed(
    "desktop and 390px mobile views have no page errors or horizontal overflow",
  );
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error instanceof Error ? error.message : String(error);
  if (page) await screenshot(page, "failure").catch(() => undefined);
  process.exitCode = 1;
} finally {
  report.apiRequestCount = requests.length;
  report.mutationCount = requests.filter(
    (request) => request.method === "POST",
  ).length;
  report.scenarioHeaderCount = requests.filter(
    (request) => request.scenarioHeader,
  ).length;
  report.pageErrors = failures;
  report.consoleErrors = consoleErrors;
  await writeFile(
    resolve(output, "backend-browser.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
