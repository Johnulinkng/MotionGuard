import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// This runner uses the actual configured loopback backend through Vite. It never mocks a response.
const baseUrl = process.env.MOTION_E2E_URL || "http://127.0.0.1:5173";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseUrl).hostname))
  throw new Error(
    "Backend scenario verification requires a loopback frontend.",
  );
const output = resolve("artifacts/backend-scenarios");
const cases = [
  { name: "normal", scenario: "normal" },
  { name: "blocked", scenario: "blocked" },
  { name: "review-approve", scenario: "review", choice: "APPROVE" },
  { name: "review-reject", scenario: "review", choice: "REJECT" },
  { name: "unknown-revoke", scenario: "unknown", operation: "revoke" },
  { name: "unknown-cancel", scenario: "unknown", operation: "cancel" },
  { name: "lesson", scenario: "lesson", choice: "REJECT" },
];
const report = {
  checkedAt: new Date().toISOString(),
  layer: "LIVE_CONFIGURED_BACKEND_BROWSER",
  frontend: baseUrl,
  executionMode: "MOCK",
  chainPaymentVerified: false,
  realModelEffectVerified: false,
  scenarioSelection:
    "explicit UI opt-in to the documented loopback backend demo controls",
  results: [],
};

function detail(dialog, label) {
  return dialog
    .locator("dt")
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator("xpath=following-sibling::dd[1]");
}

function nav(page, label) {
  return page
    .getByRole("complementary", { name: "主导航" })
    .getByRole("button", { name: label, exact: true });
}

function conserve(snapshot) {
  const budget = snapshot.budget;
  for (const field of [
    "limitAtomic",
    "settledAtomic",
    "reservedAtomic",
    "outstandingAtomic",
    "availableAtomic",
  ])
    expect(budget[field]).toMatch(/^[0-9]+$/);
  expect(
    BigInt(budget.settledAtomic) +
      BigInt(budget.reservedAtomic) +
      BigInt(budget.outstandingAtomic) +
      BigInt(budget.availableAtomic),
  ).toBe(BigInt(budget.limitAtomic));
  expect(budget.limitAtomic).toBe("1000001");
}

function budgetSummary(snapshot) {
  const {
    limitAtomic,
    settledAtomic,
    reservedAtomic,
    outstandingAtomic,
    availableAtomic,
  } = snapshot.budget;
  return {
    limitAtomic,
    settledAtomic,
    reservedAtomic,
    outstandingAtomic,
    availableAtomic,
  };
}

async function get(page, path) {
  const response = await page.request.get(`${baseUrl}/api/v1${path}`, {
    headers: { "X-Contract-Version": "0.2.0" },
  });
  const body = await response.json();
  if (!response.ok())
    throw new Error(
      `GET ${path}: HTTP ${response.status()} ${body.error?.code || "UNKNOWN_ERROR"}`,
    );
  expect(response.headers()["x-contract-version"]).toBe("0.2.0");
  expect(response.headers()["x-execution-mode"]).toBe("MOCK");
  return body;
}

async function screenshot(page, result, name) {
  await page.locator(".toast").waitFor({ state: "hidden", timeout: 6_000 });
  await page.evaluate(() => document.fonts.ready);
  const filename = `${result.name}-${name}.png`;
  await page.screenshot({
    path: resolve(output, filename),
    fullPage: true,
    animations: "disabled",
  });
  result.screenshots.push(filename);
}

async function waitSnapshot(page, taskId, statuses) {
  let snapshot;
  await expect
    .poll(
      async () => {
        snapshot = await get(page, `/tasks/${taskId}`);
        if (snapshot.status === "FAILED")
          throw new Error(`Task ${taskId} FAILED: ${snapshot.summary}`);
        return statuses.includes(snapshot.status);
      },
      { timeout: 25_000, intervals: [100, 250, 500] },
    )
    .toBe(true);
  conserve(snapshot);
  return snapshot;
}

async function enableDemo(page) {
  await page
    .getByRole("button", { name: "连接设置", exact: true })
    .first()
    .click();
  const connection = page.getByRole("dialog", {
    name: "公共 API 连接",
    exact: true,
  });
  await connection.locator("#api-origin").fill("");
  await connection.locator("#operator-token").fill("");
  await connection.getByRole("checkbox", { name: /启用.*场景/ }).check();
  await connection
    .getByRole("button", { name: "应用连接", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "新建任务", exact: true }),
  ).toBeEnabled();
}

async function createAndRun(page, specification, result) {
  const goal = `比较指定供应商的交付资料，验证 ${specification.name} 的授权与预算边界。`;
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建任务", exact: true });
  await create.locator("#goal").fill(goal);
  await create.getByLabel("总预算 (USDC)", { exact: true }).fill("1.000001");
  await create.getByLabel("最多付费次数", { exact: true }).fill("3");
  await create.locator("#scenario").selectOption(specification.scenario);
  const creation = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/tasks",
  );
  await create
    .getByRole("button", { name: "创建并生成计划", exact: true })
    .click();
  const response = await creation;
  const body = await response.json();
  if (response.status() !== 201)
    throw new Error(
      `Create ${specification.name}: HTTP ${response.status()} ${body.error?.code}`,
    );
  expect(response.request().headers()["x-mock-scenario"]).toBe(
    specification.scenario,
  );
  expect(response.request().postDataJSON()).toMatchObject({
    goal,
    budgetAtomic: "1000001",
    maxPaidCalls: 3,
    allowedVendorIds: ["vendor_alpha"],
  });
  result.taskId = body.taskId;
  await expect(
    page.getByRole("button", { name: "查看并确认计划", exact: true }),
  ).toBeEnabled({ timeout: 20_000 });
  const before = await get(page, `/tasks/${result.taskId}`);
  expect(before.authorization).toBeNull();
  const baselineLessons = await get(page, `/tasks/${result.taskId}/lessons`);
  result.baselineActiveLessons = baselineLessons.items
    .filter((lesson) => lesson.status === "ACTIVE")
    .map(({ lessonId, mechanism, memoryVersion }) => ({
      lessonId,
      mechanism,
      memoryVersion,
    }));
  await page
    .getByRole("button", { name: "查看并确认计划", exact: true })
    .click();
  const authorization = page.getByRole("dialog", {
    name: "确认资源计划",
    exact: true,
  });
  const plan = await get(page, `/tasks/${result.taskId}/resource-plan`);
  await expect(authorization).toContainText(plan.planHash);
  await expect(
    authorization.getByRole("button", { name: "确认并冻结授权", exact: true }),
  ).toBeDisabled();
  await authorization
    .getByRole("checkbox", { name: "我已核对资源、单价、次数、总额与有效期" })
    .check();
  const authorizationResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/tasks/${result.taskId}/authorize`),
  );
  await authorization
    .getByRole("button", { name: "确认并冻结授权", exact: true })
    .click();
  const authorizedResponse = await authorizationResponse;
  expect(authorizedResponse.ok()).toBe(true);
  expect(authorizedResponse.request().postDataJSON()).toEqual({
    planHash: plan.planHash,
  });
  expect(authorizedResponse.request().headers()["if-match"]).toBe(before.etag);
  await expect(
    page.getByRole("button", { name: "开始执行", exact: true }),
  ).toBeEnabled();
  const runResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/tasks/${result.taskId}/runs`),
  );
  await page.getByRole("button", { name: "开始执行", exact: true }).click();
  const started = await runResponse;
  expect(started.status()).toBe(202);
  result.planHash = plan.planHash;
  result.authorizeWithExactHashAndEtag = true;
}

async function resolveReview(page, result, choice) {
  const reviews = await get(page, `/tasks/${result.taskId}/reviews`);
  const review = reviews.items.find((item) => item.status === "PENDING");
  expect(review).toBeTruthy();
  await expect(
    page.getByRole("button", { name: "处理复核", exact: true }),
  ).toBeEnabled();
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
  await screenshot(page, result, "review");
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/reviews/${review.reviewId}/resolve`),
  );
  await dialog
    .getByRole("button", {
      name: choice === "APPROVE" ? "批准这笔计划内付款" : "拒绝付款",
      exact: true,
    })
    .click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  expect(response.request().headers()["if-match"]).toBe(review.etag);
  expect(response.request().postDataJSON()).toEqual({
    choice,
    snapshotHash: review.snapshotHash,
  });
  const resolved = await response.json();
  result.review = {
    reviewId: review.reviewId,
    choice,
    exactSnapshotAndReviewEtag: true,
    responseEtag: response.headers().etag,
    responseBodyEtag: resolved.review.etag,
  };
  expect(
    response.headers().etag,
    "ResolveReviewResult ETag must equal the nested ReviewView ETag",
  ).toBe(resolved.review.etag);
  await expect(dialog).not.toBeVisible({ timeout: 8_000 });
}

async function verifySse(page, result, snapshot) {
  await page.getByRole("tab", { name: /执行轨迹/ }).click();
  await expect(
    page
      .locator(".timeline-tag")
      .filter({ hasText: /seq \d+/ })
      .first(),
  ).toBeVisible();
  const texts = await page.locator(".timeline-tag").allTextContents();
  const sequences = texts
    .map((text) => /seq (\d+)/.exec(text)?.[1])
    .filter(Boolean)
    .map(Number);
  expect(sequences.length).toBeGreaterThan(0);
  expect(new Set(sequences).size).toBe(sequences.length);
  expect(Math.max(...sequences)).toBeLessThanOrEqual(snapshot.lastEventSeq);
  expect(result.sseResponses.length).toBeGreaterThan(0);
  for (const response of result.sseResponses) {
    expect(response.status).toBe(200);
    expect(response.executionMode).toBe("MOCK");
    expect(response.contractVersion).toBe("0.2.0");
    expect(response.cursor).toMatch(new RegExp(`^${result.taskId}:\\d+$`));
  }
  result.visibleEventSequences = sequences;
}

async function verifyPayments(page, result, scenario, choice) {
  const list = await get(page, `/tasks/${result.taskId}/payments`);
  expect(list.items.length).toBeGreaterThan(0);
  for (const payment of list.items) {
    expect(payment.executionMode).toBe("MOCK");
    expect(payment.receipt.transactionHash).toBeNull();
  }
  const payment = list.items[0];
  if (
    scenario === "normal" ||
    (scenario === "review" && choice === "APPROVE")
  ) {
    expect(payment.state).toBe("SETTLED");
    expect(payment.authorizationStatus).toBe("SIMULATED");
    expect(payment.receipt.status).toBe("SIMULATED");
  } else if (scenario === "unknown") {
    expect(payment.state).toBe("UNKNOWN");
    expect(payment.authorizationStatus).toBe("SIMULATED");
    expect(payment.receipt.status).toBe("UNKNOWN");
  } else {
    expect(payment.state).toBe("REJECTED");
    expect(payment.authorizationStatus).toBe("NOT_CREATED");
    expect(payment.receipt.status).toBe("NONE");
  }
  if (scenario === "blocked") expect(payment.decision.hardGate).toBe("BLOCK");
  result.payments = list.items.map((item) => ({
    paymentId: item.paymentId,
    state: item.state,
    amountAtomic: item.amountAtomic,
    decision: item.decision.type,
    hardGate: item.decision.hardGate,
    authorizationStatus: item.authorizationStatus,
    receiptStatus: item.receipt.status,
    transactionHash: item.receipt.transactionHash,
  }));
  await page.getByRole("tab", { name: /付款记录/ }).click();
  await page
    .getByRole("button", { name: `查看付款 ${payment.paymentId}`, exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "付款与判定详情",
    exact: true,
  });
  await expect(detail(dialog, "执行模式")).toHaveText("MOCK");
  await expect(detail(dialog, "授权状态")).toHaveText(
    payment.authorizationStatus,
  );
  await expect(detail(dialog, "回执状态")).toHaveText(payment.receipt.status);
  await expect(detail(dialog, "交易哈希")).toHaveText("无链上交易哈希");
  if (scenario === "blocked") {
    await expect(detail(dialog, "硬策略")).toContainText("BLOCK");
    await expect(
      dialog.getByRole("button", { name: /批准|忽略|继续付款/ }),
    ).toHaveCount(0);
  }
  await screenshot(page, result, "payment");
  await dialog.getByRole("button", { name: "关闭弹窗", exact: true }).click();
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const specification of cases) {
    const result = {
      name: specification.name,
      scenario: specification.scenario,
      passed: false,
      screenshots: [],
      httpErrors: [],
      pageErrors: [],
      consoleErrors: [],
      sseRequests: [],
      sseResponses: [],
    };
    report.results.push(result);
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1050 },
    });
    const mutations = [];
    const responseJobs = [];
    page.on("pageerror", (error) => result.pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") result.consoleErrors.push(message.text());
    });
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.endsWith("/events"))
        result.sseRequests.push({ cursor: request.headers()["last-event-id"] });
      if (
        request.method() !== "POST" ||
        !new URL(request.url()).pathname.startsWith("/api/v1")
      )
        return;
      mutations.push({
        path: new URL(request.url()).pathname,
        scenario: request.headers()["x-mock-scenario"] ?? null,
        idempotencyKeyValid: /^[A-Za-z0-9._:-]{8,128}$/.test(
          request.headers()["idempotency-key"] ?? "",
        ),
        strongEtag: /^"[A-Za-z0-9_:-]+"$/.test(
          request.headers()["if-match"] ?? "",
        ),
      });
    });
    page.on("response", (response) => {
      const path = new URL(response.url()).pathname;
      if (!path.startsWith("/api/v1")) return;
      if (response.headers()["content-type"]?.startsWith("text/event-stream"))
        result.sseResponses.push({
          status: response.status(),
          executionMode: response.headers()["x-execution-mode"],
          contractVersion: response.headers()["x-contract-version"],
          cursor: response.request().headers()["last-event-id"],
        });
      if (!response.ok())
        responseJobs.push(
          response
            .json()
            .then((body) =>
              result.httpErrors.push({
                path,
                status: response.status(),
                code: body.error?.code ?? "UNKNOWN_ERROR",
                requestId: body.error?.requestId,
              }),
            )
            .catch(() =>
              result.httpErrors.push({
                path,
                status: response.status(),
                code: "NON_JSON_ERROR",
              }),
            ),
        );
    });
    try {
      await page.goto(baseUrl);
      await get(page, "/catalog");
      await expect(
        page.getByRole("button", { name: "新建任务", exact: true }),
      ).toBeEnabled();
      await enableDemo(page);
      await createAndRun(page, specification, result);
      let snapshot = await waitSnapshot(
        page,
        result.taskId,
        specification.scenario === "review" ||
          specification.scenario === "lesson"
          ? ["PAUSED_REVIEW", "COMPLETED"]
          : specification.scenario === "unknown"
            ? ["AWAITING_SETTLEMENT"]
            : ["COMPLETED"],
      );
      if (snapshot.status === "PAUSED_REVIEW") {
        await resolveReview(page, result, specification.choice);
        snapshot = await waitSnapshot(page, result.taskId, ["COMPLETED"]);
      } else if (specification.scenario === "lesson") {
        expect(
          result.baselineActiveLessons.some(
            (lesson) => lesson.mechanism === "UNVERIFIED_PAYMENT_PREREQUISITE",
          ),
        ).toBe(true);
        result.lessonReviewSkipped =
          "already active matching lesson blocks the repeated sandbox prerequisite";
      }
      await expect(page.locator(".task-topline")).toContainText(
        specification.scenario === "unknown" ? "等待结算确认" : "任务已结束",
        { timeout: 10_000 },
      );
      await verifySse(page, result, snapshot);
      await verifyPayments(
        page,
        result,
        specification.scenario,
        specification.choice,
      );

      if (specification.operation) {
        const outstanding = snapshot.budget.outstandingAtomic;
        expect(BigInt(outstanding)).toBeGreaterThan(0n);
        const revoke = specification.operation === "revoke";
        await page
          .getByRole("button", {
            name: revoke ? "撤销授权" : "取消任务",
            exact: true,
          })
          .click();
        const dialog = page.getByRole("dialog", {
          name: revoke ? "撤销任务授权" : "取消任务",
          exact: true,
        });
        await expect(dialog).toContainText("取消或撤销不代表退款");
        const stopResponse = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            response
              .url()
              .endsWith(`/tasks/${result.taskId}/${specification.operation}`),
        );
        await dialog
          .getByRole("button", {
            name: revoke ? "确认撤销授权" : "确认取消任务",
            exact: true,
          })
          .click();
        expect((await stopResponse).ok()).toBe(true);
        snapshot = await get(page, `/tasks/${result.taskId}`);
        conserve(snapshot);
        expect(snapshot.authorization.status).toBe("REVOKED");
        expect(snapshot.budget.outstandingAtomic).toBe(outstanding);
        expect(snapshot.budget.settledAtomic).toBe("0");
        expect(snapshot.status).toBe(revoke ? "FAILED" : "CANCELLED");
        result.unknownExposurePreservedAfter = specification.operation;
      }

      if (specification.scenario === "lesson") {
        const lessons = await get(page, `/tasks/${result.taskId}/lessons`);
        const active = lessons.items.filter(
          (lesson) =>
            lesson.status === "ACTIVE" &&
            lesson.mechanism === "UNVERIFIED_PAYMENT_PREREQUISITE",
        );
        expect(active.length).toBeGreaterThan(0);
        for (const lesson of active) {
          expect(lesson.promotion.originReplayPassed).toBe(true);
          expect(lesson.promotion.variantPassed).toBeGreaterThanOrEqual(2);
          expect(lesson.promotion.benignPassed).toBeGreaterThanOrEqual(2);
          expect(lesson.promotion.regressionPassed).toBe(true);
          expect(lesson.promotion.permissionsUnchanged).toBe(true);
        }
        result.activeLessons = active.map(
          ({ lessonId, mechanism, memoryVersion, promotion }) => ({
            lessonId,
            mechanism,
            memoryVersion,
            promotion,
          }),
        );
        result.newPromotionCount = active.filter(
          (lesson) =>
            !result.baselineActiveLessons.some(
              (before) => before.lessonId === lesson.lessonId,
            ),
        ).length;
        await nav(page, "经验库").click();
        await expect(
          page
            .locator(".lesson-card")
            .filter({ hasText: "UNVERIFIED_PAYMENT_PREREQUISITE" })
            .first(),
        ).toContainText("已晋升");
        await screenshot(page, result, "active-lessons");
      } else {
        await page.getByRole("tab", { name: /执行轨迹/ }).click();
        await screenshot(page, result, "finished");
      }

      if (specification.scenario === "normal") {
        const count = mutations.length;
        const cursor = snapshot.lastEventSeq;
        await page.reload();
        await expect(page.locator(".task-id")).toHaveText(result.taskId);
        await expect(page.locator(".task-topline")).toContainText("任务已结束");
        const recovered = await get(page, `/tasks/${result.taskId}`);
        expect(recovered.lastEventSeq).toBeGreaterThanOrEqual(cursor);
        expect(mutations).toHaveLength(count);
        await expect
          .poll(
            () =>
              result.sseRequests.some(
                (request) =>
                  request.cursor ===
                  `${result.taskId}:${recovered.lastEventSeq}`,
              ),
            { timeout: 8_000 },
          )
          .toBe(true);
        result.reloadEventCursor = `${result.taskId}:${recovered.lastEventSeq}`;
        result.reloadRecoveryWithoutMutation = true;
      }

      for (const mutation of mutations) {
        expect(mutation.idempotencyKeyValid).toBe(true);
        if (mutation.path === "/api/v1/tasks")
          expect(mutation.scenario).toBe(specification.scenario);
        else {
          expect(mutation.strongEtag).toBe(true);
          expect(mutation.scenario).toBeNull();
        }
      }
      await Promise.all(responseJobs);
      expect(result.httpErrors).toEqual([]);
      expect(result.pageErrors).toEqual([]);
      expect(result.consoleErrors).toEqual([]);
      result.status = snapshot.status;
      result.budget = budgetSummary(snapshot);
      result.mutationCount = mutations.length;
      result.passed = true;
    } catch (error) {
      result.failure = error instanceof Error ? error.message : String(error);
      if (result.taskId) {
        const snapshot = await get(page, `/tasks/${result.taskId}`).catch(
          () => null,
        );
        if (snapshot) {
          result.status = snapshot.status;
          result.budget = budgetSummary(snapshot);
        }
      }
      await screenshot(page, result, "failure").catch(() => undefined);
      await Promise.all(responseJobs);
      process.exitCode = 1;
    } finally {
      await page.close();
      console.log(
        JSON.stringify({
          name: result.name,
          passed: result.passed,
          taskId: result.taskId,
          status: result.status,
          failure: result.failure,
          httpErrors: result.httpErrors,
        }),
      );
      await writeFile(
        resolve(output, "report.json"),
        `${JSON.stringify(report, null, 2)}\n`,
      );
    }
  }
} finally {
  report.passed = report.results.every((result) => result.passed);
  report.passedCases = report.results.filter((result) => result.passed).length;
  report.totalCases = cases.length;
  await writeFile(
    resolve(output, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await browser.close();
  console.log(
    JSON.stringify({
      passed: report.passed,
      passedCases: report.passedCases,
      totalCases: report.totalCases,
      report: resolve(output, "report.json"),
    }),
  );
}
