import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const api = "http://127.0.0.1:4010";
async function request(path, body, etag) {
  const response = await fetch(`${api}/api/v1${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "X-Contract-Version": "0.2.0",
      ...(body
        ? {
            "Content-Type": "application/json",
            "Idempotency-Key": `capture-${crypto.randomUUID()}`,
            "X-Mock-Scenario": "review",
          }
        : {}),
      ...(etag ? { "If-Match": etag } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok || response.headers.get("X-Execution-Mode") !== "MOCK")
    throw new Error(`Expected local MOCK, received ${response.status}`);
  return response.json();
}
const task = await request("/tasks", {
  goal: "比较指定供应商的交付条件，购买完成比较所需的资料。",
  allowedVendorIds: ["vendor_alpha", "vendor_beta"],
  budgetAtomic: "1000000",
  maxPaidCalls: 3,
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
});
await request(`/tasks/${task.taskId}/plan`, {}, task.etag);
let snapshot;
do {
  await new Promise((resolve) => setTimeout(resolve, 100));
  snapshot = await request(`/tasks/${task.taskId}`);
} while (snapshot.status === "PLANNING");
const plan = await request(`/tasks/${task.taskId}/resource-plan`);
snapshot = await request(
  `/tasks/${task.taskId}/authorize`,
  { planHash: plan.planHash },
  snapshot.etag,
);
await request(
  `/tasks/${task.taskId}/runs`,
  { authorizationVersion: snapshot.authorization.version },
  snapshot.etag,
);
await new Promise((resolve) => setTimeout(resolve, 150));
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
    deviceScaleFactor: 1,
  });
  await page.goto(`http://127.0.0.1:5173/?task=${task.taskId}`);
  await page.getByRole("button", { name: "处理复核" }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({
    path: "artifacts/workspace-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("tab", { name: /付款记录/ }).click();
  await page.screenshot({
    path: "artifacts/payments-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "处理复核" }).click();
  await page.screenshot({
    path: "artifacts/review-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "关闭弹窗" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: /执行轨迹/ }).click();
  await page.screenshot({
    path: "artifacts/workspace-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await writeFile(
    "artifacts/capture.json",
    JSON.stringify(
      {
        executionMode: "MOCK",
        taskId: task.taskId,
        capturedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
