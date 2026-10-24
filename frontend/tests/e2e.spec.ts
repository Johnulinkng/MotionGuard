import { randomUUID } from "node:crypto";
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import type {
  EvidenceSummary,
  PaymentView,
  ResourcePlan,
  ReviewView,
  TaskSnapshot,
} from "../src/api/types";

type Scenario = "normal" | "blocked" | "review" | "unknown" | "lesson";
const version = "0.2.0";
const viewVersion = "0.1.0";

async function apiGet<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(`/api/v1${path}`, {
    headers: { "X-Contract-Version": version },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  expect(response.headers()["x-execution-mode"]).toBe("MOCK");
  return response.json() as Promise<T>;
}

async function apiPost<T>(
  request: APIRequestContext,
  path: string,
  body: unknown,
  etag?: string,
  scenario?: Scenario,
): Promise<T> {
  const response = await request.post(`/api/v1${path}`, {
    data: body,
    headers: {
      "X-Contract-Version": version,
      "Idempotency-Key": `e2e-${randomUUID()}`,
      ...(etag ? { "If-Match": etag } : {}),
      ...(scenario ? { "X-Mock-Scenario": scenario } : {}),
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  expect(response.headers()["x-execution-mode"]).toBe("MOCK");
  return response.json() as Promise<T>;
}

async function waitTask(
  request: APIRequestContext,
  taskId: string,
  status: TaskSnapshot["status"],
) {
  let snapshot: TaskSnapshot;
  await expect
    .poll(async () => {
      snapshot = await apiGet<TaskSnapshot>(request, `/tasks/${taskId}`);
      return snapshot.status;
    })
    .toBe(status);
  return snapshot!;
}

async function readyTask(request: APIRequestContext, scenario: Scenario) {
  const created = await apiPost<TaskSnapshot>(
    request,
    "/tasks",
    {
      goal: `端到端验证 ${scenario} 场景的授权边界`,
      allowedVendorIds: ["vendor_alpha"],
      budgetAtomic: "1000000",
      maxPaidCalls: 3,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
    undefined,
    scenario,
  );
  await apiPost(request, `/tasks/${created.taskId}/plan`, {}, created.etag);
  const task = await waitTask(
    request,
    created.taskId,
    "AWAITING_AUTHORIZATION",
  );
  const plan = await apiGet<ResourcePlan>(
    request,
    `/tasks/${task.taskId}/resource-plan`,
  );
  return apiPost<TaskSnapshot>(
    request,
    `/tasks/${task.taskId}/authorize`,
    { planHash: plan.planHash },
    task.etag,
  );
}

async function runScenario(request: APIRequestContext, scenario: Scenario) {
  const task = await readyTask(request, scenario);
  await apiPost(
    request,
    `/tasks/${task.taskId}/runs`,
    { authorizationVersion: task.authorization!.version },
    task.etag,
  );
  return waitTask(
    request,
    task.taskId,
    scenario === "review"
      ? "PAUSED_REVIEW"
      : scenario === "unknown"
        ? "AWAITING_SETTLEMENT"
        : "COMPLETED",
  );
}

async function visit(page: Page) {
  await page.goto("/");
  await expect(page.locator(".mock-banner")).toContainText("MOCK");
  await expect(
    page.getByRole("button", { name: "新建任务", exact: true }),
  ).toBeEnabled();
}

async function openTask(page: Page, taskId: string) {
  await page
    .getByRole("button", { name: "打开任务", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "打开任务", exact: true });
  await dialog.getByLabel("任务 ID", { exact: true }).fill(taskId);
  await dialog.getByRole("button", { name: "打开任务", exact: true }).click();
  await expect(page.locator(".task-id")).toHaveText(taskId);
}

async function nav(page: Page, label: string) {
  await page
    .getByRole("complementary", { name: "主导航" })
    .getByRole("button", { name: label, exact: true })
    .click();
}

function detail(dialog: Locator, label: string) {
  return dialog
    .locator("dt")
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator("xpath=following-sibling::dd[1]");
}

function assertBudget(task: TaskSnapshot) {
  const budget = task.budget;
  expect(
    BigInt(budget.settledAtomic) +
      BigInt(budget.reservedAtomic) +
      BigInt(budget.outstandingAtomic) +
      BigInt(budget.availableAtomic),
  ).toBe(BigInt(budget.limitAtomic));
}

test("完整创建、精确预算、确认计划、冻结授权与模拟付款", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  const mutations: Array<{ path: string; headers: Record<string, string> }> =
    [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (req) => {
    if (
      req.method() === "POST" &&
      new URL(req.url()).pathname.startsWith("/api/v1")
    )
      mutations.push({
        path: new URL(req.url()).pathname,
        headers: req.headers(),
      });
  });
  await visit(page);
  await expect(page.locator(".stats-grid")).toHaveCount(0);
  await expect(page.getByLabel("任务目标预览", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建任务", exact: true });
  await create
    .getByLabel("任务目标")
    .fill("比较供应商的资料交付条件，严格遵守本次预算。");
  await create.getByLabel("总预算 (USDC)", { exact: true }).fill("0.0000001");
  await create
    .getByRole("button", { name: "创建并生成计划", exact: true })
    .click();
  await expect(create.getByRole("alert")).toContainText("最多 6 位小数");
  expect(mutations).toHaveLength(0);
  await create.getByLabel("总预算 (USDC)", { exact: true }).fill("1.000001");
  await create.getByLabel("最多付费次数", { exact: true }).fill("3");
  await create.getByLabel("授权有效期", { exact: true }).selectOption("4");
  await create.getByLabel("演示场景").selectOption("normal");
  const createdResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/tasks",
  );
  await create
    .getByRole("button", { name: "创建并生成计划", exact: true })
    .click();
  const response = await createdResponse;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toMatchObject({
    budgetAtomic: "1000001",
    allowedVendorIds: ["vendor_alpha"],
    maxPaidCalls: 3,
  });
  const created = (await response.json()) as TaskSnapshot;
  await expect(
    page.getByRole("button", { name: "查看并确认计划", exact: true }),
  ).toBeEnabled();
  expect(
    (await apiGet<TaskSnapshot>(request, `/tasks/${created.taskId}`))
      .authorization,
  ).toBeNull();
  await page
    .getByRole("button", { name: "查看并确认计划", exact: true })
    .click();
  const authorize = page.getByRole("dialog", {
    name: "确认资源计划",
    exact: true,
  });
  const plan = await apiGet<ResourcePlan>(
    request,
    `/tasks/${created.taskId}/resource-plan`,
  );
  await expect(authorize).toContainText(plan.planHash);
  await expect(authorize).toContainText("1.000001 USDC");
  await expect(
    authorize.getByRole("button", { name: "确认并冻结授权", exact: true }),
  ).toBeDisabled();
  await authorize
    .getByRole("checkbox", { name: "我已核对资源、单价、次数、总额与有效期" })
    .check();
  const authorizeRequest = page.waitForRequest(
    (req) => req.method() === "POST" && req.url().endsWith("/authorize"),
  );
  await authorize
    .getByRole("button", { name: "确认并冻结授权", exact: true })
    .click();
  expect((await authorizeRequest).postDataJSON()).toEqual({
    planHash: plan.planHash,
  });
  await expect(
    page.getByRole("button", { name: "开始执行", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "开始执行", exact: true }).click();
  await expect(page.locator(".task-topline")).toContainText("任务已结束");
  const finished = await apiGet<TaskSnapshot>(
    request,
    `/tasks/${created.taskId}`,
  );
  assertBudget(finished);
  expect(finished.budget).toMatchObject({
    limitAtomic: "1000001",
    settledAtomic: "10000",
    availableAtomic: "990001",
    outstandingAtomic: "0",
  });
  const budget = page.getByRole("region", { name: "任务预算" });
  await expect(
    budget.locator(".budget-row").filter({ hasText: "已结算" }),
  ).toContainText("0.01 USDC");
  await expect(
    budget.locator(".budget-row").filter({ hasText: "可用额度" }),
  ).toContainText("0.990001 USDC");
  await nav(page, "付款记录");
  await expect(page.locator(".data-table tbody tr")).toHaveCount(1);
  const list = await apiGet<{ items: PaymentView[] }>(
    request,
    `/tasks/${created.taskId}/payments`,
  );
  const payment = list.items[0];
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
  await expect(paymentDialog.locator(".evidence-box")).toBeVisible();
  expect(payment.receipt.transactionHash).toBeNull();
  expect(mutations).toHaveLength(4);
  for (const mutation of mutations) {
    expect(mutation.headers["x-contract-version"]).toBe(version);
    expect(mutation.headers["idempotency-key"]).toMatch(
      /^[A-Za-z0-9._:-]{8,128}$/,
    );
    if (mutation.path !== "/api/v1/tasks")
      expect(mutation.headers["if-match"]).toMatch(/^"[A-Za-z0-9_:-]+"$/);
  }
  expect(errors).toEqual([]);
});

test("硬策略阻断不创建授权，也不提供覆盖复核入口", async ({
  page,
  request,
}) => {
  const task = await runScenario(request, "blocked");
  assertBudget(task);
  expect(task.budget).toMatchObject({
    settledAtomic: "0",
    reservedAtomic: "0",
    outstandingAtomic: "0",
    availableAtomic: "1000000",
  });
  await visit(page);
  await openTask(page, task.taskId);
  await expect(
    page.getByRole("button", { name: "处理复核", exact: true }),
  ).toHaveCount(0);
  await nav(page, "付款记录");
  const list = await apiGet<{ items: PaymentView[] }>(
    request,
    `/tasks/${task.taskId}/payments`,
  );
  expect(list.items[0]).toMatchObject({
    state: "REJECTED",
    authorizationStatus: "NOT_CREATED",
    receipt: { status: "NONE", transactionHash: null },
    decision: { hardGate: "BLOCK" },
  });
  await page
    .getByRole("button", {
      name: `查看付款 ${list.items[0].paymentId}`,
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "付款与判定详情",
    exact: true,
  });
  await expect(detail(dialog, "硬策略")).toHaveText("BLOCK · 禁止通过复核覆盖");
  await expect(detail(dialog, "授权状态")).toHaveText("NOT_CREATED");
  await expect(detail(dialog, "回执状态")).toHaveText("NONE");
  await expect(
    dialog.getByRole("button", { name: /批准|忽略|继续付款/ }),
  ).toHaveCount(0);
});

for (const choice of ["APPROVE", "REJECT"] as const) {
  test(`人工复核 ${choice} 绑定精确快照与 review ETag`, async ({
    page,
    request,
  }) => {
    const task = await runScenario(request, "review");
    const reviews = await apiGet<{ items: ReviewView[] }>(
      request,
      `/tasks/${task.taskId}/reviews`,
    );
    const review = reviews.items[0];
    await visit(page);
    await openTask(page, task.taskId);
    await page.getByRole("button", { name: "处理复核", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "复核计划内付款",
      exact: true,
    });
    await expect(detail(dialog, "完整收款地址")).toHaveText(review.payTo);
    await expect(detail(dialog, "快照摘要")).toHaveText(review.snapshotHash);
    await expect(detail(dialog, "硬策略")).toHaveText("PASS");
    const approve = dialog.getByRole("button", {
      name: "批准这笔计划内付款",
      exact: true,
    });
    await expect(approve).toBeDisabled();
    if (choice === "APPROVE") await dialog.getByRole("checkbox").check();
    const resolvedRequest = page.waitForRequest(
      (req) =>
        req.method() === "POST" &&
        req.url().endsWith(`/reviews/${review.reviewId}/resolve`),
    );
    await dialog
      .getByRole("button", {
        name: choice === "APPROVE" ? "批准这笔计划内付款" : "拒绝付款",
        exact: true,
      })
      .click();
    const resolve = await resolvedRequest;
    expect(resolve.headers()["if-match"]).toBe(review.etag);
    expect(resolve.headers()["if-match"]).not.toBe(task.etag);
    expect(resolve.postDataJSON()).toEqual({
      choice,
      snapshotHash: review.snapshotHash,
    });
    await expect(page.locator(".task-topline")).toContainText("任务已结束");
    const finished = await waitTask(request, task.taskId, "COMPLETED");
    assertBudget(finished);
    expect(finished.budget.settledAtomic).toBe(
      choice === "APPROVE" ? "10000" : "0",
    );
    expect(finished.budget.outstandingAtomic).toBe("0");
    const payments = await apiGet<{ items: PaymentView[] }>(
      request,
      `/tasks/${task.taskId}/payments`,
    );
    expect(payments.items).toHaveLength(1);
    expect(payments.items[0].authorizationStatus).toBe(
      choice === "APPROVE" ? "SIMULATED" : "NOT_CREATED",
    );
    expect(payments.items[0].receipt.transactionHash).toBeNull();
  });
}

test("未知结算撤销后仍保留 outstanding，不显示成退款", async ({
  page,
  request,
}) => {
  const task = await runScenario(request, "unknown");
  await visit(page);
  await openTask(page, task.taskId);
  await expect(page.locator(".task-topline")).toContainText("等待结算确认");
  const budget = page.getByRole("region", { name: "任务预算" });
  await expect(
    budget.locator(".budget-row").filter({ hasText: "待确认占用" }),
  ).toContainText("0.01 USDC");
  await expect(
    budget.locator(".budget-row").filter({ hasText: "可用额度" }),
  ).toContainText("0.99 USDC");
  await page.getByRole("button", { name: "撤销授权", exact: true }).click();
  const revoke = page.getByRole("dialog", {
    name: "撤销任务授权",
    exact: true,
  });
  await expect(revoke).toContainText("取消或撤销不代表退款");
  await expect(revoke).toContainText("待确认占用：0.01 USDC");
  await revoke
    .getByRole("button", { name: "确认撤销授权", exact: true })
    .click();
  await expect(page.locator(".task-topline")).toContainText("已取消");
  const cancelled = await apiGet<TaskSnapshot>(
    request,
    `/tasks/${task.taskId}`,
  );
  assertBudget(cancelled);
  expect(cancelled.authorization?.status).toBe("REVOKED");
  expect(cancelled.budget).toMatchObject({
    settledAtomic: "0",
    reservedAtomic: "0",
    outstandingAtomic: "10000",
    availableAtomic: "990000",
  });
  await expect(
    budget.locator(".budget-row").filter({ hasText: "待确认占用" }),
  ).toContainText("0.01 USDC");
  await nav(page, "付款记录");
  await page.getByRole("button", { name: "结算未知", exact: true }).click();
  const payments = await apiGet<{ items: PaymentView[] }>(
    request,
    `/tasks/${task.taskId}/payments`,
  );
  await page
    .getByRole("button", {
      name: `查看付款 ${payments.items[0].paymentId}`,
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "付款与判定详情",
    exact: true,
  });
  await expect(detail(dialog, "授权状态")).toHaveText("SIMULATED");
  await expect(detail(dialog, "回执状态")).toHaveText("UNKNOWN");
  await expect(detail(dialog, "交易哈希")).toHaveText("无链上交易哈希");
});

test("经验晋升只读，持续注明 MOCK 和实验边界", async ({ page, request }) => {
  const task = await runScenario(request, "lesson");
  await visit(page);
  await openTask(page, task.taskId);
  let posts = 0;
  page.on("request", (req) => {
    if (req.method() === "POST") posts++;
  });
  await nav(page, "经验库");
  await expect(page.locator(".preview-intro")).toContainText(
    "示例不构成真实学习实验或收益证据",
  );
  await expect(page.locator(".lesson-card")).toContainText("已晋升 · MOCK");
  await expect(page.locator(".lesson-card")).toContainText("memory_m1");
  await page.getByRole("button", { name: "验证记录", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "防御经验与验证记录",
    exact: true,
  });
  await expect(dialog).toContainText("不代表实际学习实验已完成或统计收益");
  await expect(dialog).toContainText("独立变体 2 个（至少 2 个）");
  await expect(dialog).toContainText("良性反例 2 个（至少 2 个）");
  await expect(
    dialog.getByRole("button", { name: /晋升|增加|启用|放宽/ }),
  ).toHaveCount(0);
  expect(posts).toBe(0);
});

test("412 刷新权威快照并要求重新确认，不自动重放资金操作", async ({
  page,
  request,
}) => {
  const task = await readyTask(request, "normal");
  await visit(page);
  await openTask(page, task.taskId);
  let runRequests = 0;
  await page.route(`**/api/v1/tasks/${task.taskId}/runs`, async (route) => {
    runRequests++;
    await route.fulfill({
      status: 412,
      contentType: "application/json",
      headers: { "X-Contract-Version": version, "X-Execution-Mode": "MOCK" },
      body: JSON.stringify({
        schemaVersion: viewVersion,
        error: {
          code: "PRECONDITION_FAILED",
          message: "任务快照已改变。",
          requestId: "e2e_stale_snapshot",
        },
      }),
    });
  });
  await page.getByRole("button", { name: "开始执行", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("已重新读取快照");
  await expect(page.getByRole("alert")).toContainText("刚才的操作没有自动重试");
  expect(runRequests).toBe(1);
  expect(
    (await apiGet<TaskSnapshot>(request, `/tasks/${task.taskId}`)).status,
  ).toBe("READY");
  await expect(
    page.getByRole("button", { name: "开始执行", exact: true }),
  ).toBeEnabled();
});

test("会话仅在内存，Bearer 不进 URL、存储、SSE 查询和导出", async ({
  page,
  request,
}) => {
  await visit(page);
  const token = "MOCK-e2e-in-memory-session";
  await page
    .getByRole("button", { name: "配置操作员会话", exact: true })
    .click();
  const connect = page.getByRole("dialog", {
    name: "公共 API 连接",
    exact: true,
  });
  await connect.getByLabel("Operator session").fill(token);
  await connect.getByRole("button", { name: "应用连接", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "新建任务", exact: true }),
  ).toBeEnabled();
  const task = await runScenario(request, "normal");
  const eventRequest = page.waitForRequest(
    (req) =>
      new URL(req.url()).pathname === `/api/v1/tasks/${task.taskId}/events`,
  );
  await openTask(page, task.taskId);
  const stream = await eventRequest;
  expect(stream.headers().authorization).toBe(`Bearer ${token}`);
  expect(stream.headers()["x-contract-version"]).toBe(version);
  expect(stream.headers()["last-event-id"]).toBe(
    `${task.taskId}:${task.lastEventSeq}`,
  );
  expect(new URL(stream.url()).search).toBe("");
  expect(page.url()).not.toContain(token);
  expect(
    await page.evaluate(() => ({
      local: { ...localStorage },
      session: { ...sessionStorage },
    })),
  ).toEqual({ local: {}, session: {} });
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "导出公共任务记录", exact: true })
    .click();
  const download = await downloadPromise;
  const streamBody = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of streamBody!) chunks.push(Buffer.from(chunk));
  const exportedText = Buffer.concat(chunks).toString("utf8");
  const exported = JSON.parse(exportedText);
  expect(exported.executionMode).toBe("MOCK");
  expect(exported.task.taskId).toBe(task.taskId);
  expect(exportedText).not.toContain(token);
  expect(exportedText).not.toContain("Bearer ");
  expect(exportedText).not.toContain("SIGNED_TESTNET");
});

test("移动端导航与弹窗无横向溢出，键盘焦点留在弹窗内", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await visit(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    )
    .toBeLessThanOrEqual(1);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.screenshot({ path: "artifacts/mobile-fresh.png", fullPage: true });
  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await nav(page, "可信目录");
  await expect(
    page.getByRole("heading", { name: "可信资源目录", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".vendor-card")).toHaveCount(3);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    )
    .toBeLessThanOrEqual(1);
  const trigger = page.getByRole("button", { name: "新建任务", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "新建任务", exact: true });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "关闭弹窗", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "创建并生成计划", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "关闭弹窗", exact: true }),
  ).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    )
    .toBeLessThanOrEqual(1);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("切换付款后丢弃旧来源请求的迟到错误", async ({ page, request }) => {
  const first = await runScenario(request, "normal");
  const second = await runScenario(request, "blocked");
  const firstPayments = await apiGet<{ items: PaymentView[] }>(
    request,
    `/tasks/${first.taskId}/payments`,
  );
  const secondPayments = await apiGet<{ items: PaymentView[] }>(
    request,
    `/tasks/${second.taskId}/payments`,
  );
  const oldEvidencePath = `/api/v1/tasks/${first.taskId}/evidence/${firstPayments.items[0].decision.evidenceIds[0]}`;
  let releaseOld!: () => void;
  let evidenceStarted!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  const started = new Promise<void>((resolve) => {
    evidenceStarted = resolve;
  });
  // Transport-only fault injection: the original task's delayed evidence request fails.
  // The second task and its evidence still come from the published mock unchanged.
  await page.route(`**${oldEvidencePath}`, async (route) => {
    evidenceStarted();
    await release;
    await route.abort("failed");
  });
  await visit(page);
  await openTask(page, first.taskId);
  await nav(page, "付款记录");
  await page
    .getByRole("button", {
      name: `查看付款 ${firstPayments.items[0].paymentId}`,
      exact: true,
    })
    .click();
  await started;
  await page
    .getByRole("dialog", { name: "付款与判定详情", exact: true })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await openTask(page, second.taskId);
  await nav(page, "付款记录");
  await page
    .getByRole("button", {
      name: `查看付款 ${secondPayments.items[0].paymentId}`,
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "付款与判定详情",
    exact: true,
  });
  await expect(dialog.locator(".evidence-box")).toBeVisible();
  const failedRequest = page.waitForEvent(
    "requestfailed",
    (req) => new URL(req.url()).pathname === oldEvidencePath,
  );
  releaseOld();
  await failedRequest;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(dialog.locator(".form-error")).toHaveCount(0);
  await expect(dialog.locator(".evidence-box")).toBeVisible();
});

test("切换付款后迟到的 A 来源不能覆盖 B 的来源", async ({ page, request }) => {
  const first = await runScenario(request, "normal");
  const second = await runScenario(request, "blocked");
  const firstPayments = await apiGet<{ items: PaymentView[] }>(
    request,
    `/tasks/${first.taskId}/payments`,
  );
  const secondPayments = await apiGet<{ items: PaymentView[] }>(
    request,
    `/tasks/${second.taskId}/payments`,
  );
  const firstPath = `/api/v1/tasks/${first.taskId}/evidence/${firstPayments.items[0].decision.evidenceIds[0]}`;
  const secondPath = `/api/v1/tasks/${second.taskId}/evidence/${secondPayments.items[0].decision.evidenceIds[0]}`;
  const sourceB =
    'MOCK 回归来源 B：<img src=x onerror="alert(1)"> 此内容只属于当前付款。';
  let releaseOld!: () => void;
  let evidenceStarted!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  const started = new Promise<void>((resolve) => {
    evidenceStarted = resolve;
  });
  // Both schema-valid excerpts are explicitly tagged MOCK race-regression fixtures.
  // Response IDs, modes, headers, and all other fields come from the published mock.
  await page.route(`**${firstPath}`, async (route) => {
    const response = await route.fetch();
    const evidence = (await response.json()) as EvidenceSummary;
    evidenceStarted();
    await release;
    await route.fulfill({
      response,
      json: { ...evidence, excerpt: "MOCK 回归来源 A：此内容只属于旧付款。" },
    });
  });
  await page.route(`**${secondPath}`, async (route) => {
    const response = await route.fetch();
    const evidence = (await response.json()) as EvidenceSummary;
    await route.fulfill({ response, json: { ...evidence, excerpt: sourceB } });
  });
  await visit(page);
  await openTask(page, first.taskId);
  await nav(page, "付款记录");
  await page
    .getByRole("button", {
      name: `查看付款 ${firstPayments.items[0].paymentId}`,
      exact: true,
    })
    .click();
  await started;
  await page
    .getByRole("dialog", { name: "付款与判定详情", exact: true })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await openTask(page, second.taskId);
  await nav(page, "付款记录");
  await page
    .getByRole("button", {
      name: `查看付款 ${secondPayments.items[0].paymentId}`,
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "付款与判定详情",
    exact: true,
  });
  await expect(dialog.locator(".evidence-box")).toHaveText(sourceB);
  await expect(dialog.locator(".evidence-box img")).toHaveCount(0);
  const lateResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === firstPath,
  );
  releaseOld();
  await (await lateResponse).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(dialog.locator(".evidence-box")).toHaveText(sourceB);
});

test("操作已受理但同步失败时说明实际阶段，冻结旧操作并保留刷新入口", async ({
  page,
  request,
}) => {
  const task = await readyTask(request, "normal");
  await visit(page);
  await openTask(page, task.taskId);
  let failReads = false;
  let runRequests = 0;
  await page.route(`**/api/v1/tasks/${task.taskId}`, async (route) => {
    if (failReads) await route.abort("failed");
    else await route.continue();
  });
  await page.route(`**/api/v1/tasks/${task.taskId}/runs`, async (route) => {
    runRequests++;
    const response = await route.fetch();
    expect(response.status()).toBe(202);
    failReads = true;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "开始执行", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("操作已受理");
  await expect(page.getByRole("alert")).toContainText("最新状态同步失败");
  await expect(
    page.getByRole("button", { name: "开始执行", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "刷新快照", exact: true }),
  ).toBeEnabled();
  const completed = await waitTask(request, task.taskId, "COMPLETED");
  expect(completed.budget.settledAtomic).toBe("10000");
  expect(runRequests).toBe(1);
  failReads = false;
  await page.getByRole("button", { name: "刷新快照", exact: true }).click();
  await expect(page.locator(".task-topline")).toContainText("任务已结束");
  expect(runRequests).toBe(1);
});

test("412 后快照读取失败时明确未刷新，旧资金操作保持禁用", async ({
  page,
  request,
}) => {
  const task = await readyTask(request, "normal");
  await visit(page);
  await openTask(page, task.taskId);
  let failReads = false;
  let runRequests = 0;
  await page.route(`**/api/v1/tasks/${task.taskId}`, async (route) => {
    if (failReads) await route.abort("failed");
    else await route.continue();
  });
  await page.route(`**/api/v1/tasks/${task.taskId}/runs`, async (route) => {
    runRequests++;
    failReads = true;
    await route.fulfill({
      status: 412,
      contentType: "application/json",
      headers: { "X-Contract-Version": version, "X-Execution-Mode": "MOCK" },
      body: JSON.stringify({
        schemaVersion: viewVersion,
        error: {
          code: "PRECONDITION_FAILED",
          message: "任务快照已改变。",
          requestId: "e2e_stale_refresh_failed",
        },
      }),
    });
  });
  await page.getByRole("button", { name: "开始执行", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("最新快照读取失败");
  await expect(page.getByRole("alert")).not.toContainText("已重新读取快照");
  await expect(
    page.getByRole("button", { name: "开始执行", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "刷新快照", exact: true }),
  ).toBeEnabled();
  expect(runRequests).toBe(1);
  expect(
    (await apiGet<TaskSnapshot>(request, `/tasks/${task.taskId}`)).status,
  ).toBe("READY");
  failReads = false;
  await page.getByRole("button", { name: "刷新快照", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "开始执行", exact: true }),
  ).toBeEnabled();
  expect(runRequests).toBe(1);
});

test("成功 HTTP 响应未通过校验时只刷新实际结果，不重复提交", async ({
  page,
  request,
}) => {
  const task = await readyTask(request, "normal");
  await visit(page);
  await openTask(page, task.taskId);
  let runRequests = 0;
  await page.route(`**/api/v1/tasks/${task.taskId}/runs`, async (route) => {
    runRequests++;
    const response = await route.fetch();
    expect(response.status()).toBe(202);
    await route.fulfill({
      response,
      headers: { ...response.headers(), etag: '"incorrect_snapshot:v1"' },
    });
  });
  await page.getByRole("button", { name: "开始执行", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "服务返回了成功状态，但响应未通过校验",
  );
  await expect(page.getByRole("alert")).toContainText("没有自动重试");
  const completed = await waitTask(request, task.taskId, "COMPLETED");
  expect(completed.budget.settledAtomic).toBe("10000");
  await expect(page.locator(".task-topline")).toContainText("任务已结束");
  expect(runRequests).toBe(1);
});
