import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { projectRoot, verifyContract } from "./check-contract.mjs";

const backendRoot = resolve(projectRoot, "../backend");
const self = fileURLToPath(import.meta.url);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const strongEtag = /^"[A-Za-z0-9_:-]+"$/;
const forbidden =
  /^(?:privateKey|payerKey|operatorToken|operatorSessionToken|signature|rawSignature|paymentSignature|signedPayload|executionGrant|secret|apiKey|ipcCredential|chainOfThought|hiddenReasoning|databasePath|storagePath)$/i;

// This private child imports the real provider, never the published fixture server.
// Configuration arrives over IPC; no credential is placed in argv or a file.
async function backendChild() {
  assert.equal(typeof process.send, "function", "Private child requires IPC.");
  let app;
  process.on("message", async (message) => {
    try {
      if (message?.type === "start" && !app) {
        const { createApp } = await import(
          pathToFileURL(join(backendRoot, "src/server.ts")).href
        );
        app = await createApp({
          dbPath: message.dbPath,
          operatorToken: message.token,
          authRequired: true,
          executionMode: "MOCK",
          allowedOrigins: ["http://127.0.0.1:5173", "http://localhost:5173"],
        });
        app.server.once("error", () =>
          process.send?.({ type: "failed", code: "BACKEND_LISTEN_FAILED" }),
        );
        app.server.listen(message.port, "127.0.0.1", () =>
          process.send?.({ type: "ready", pid: process.pid }),
        );
      } else if (message?.type === "stop") {
        await app?.close();
        process.send?.({ type: "closed" });
        process.disconnect();
      }
    } catch {
      process.send?.({ type: "failed", code: "BACKEND_START_OR_CLOSE_FAILED" });
      await app?.close().catch(() => {});
      process.disconnect();
      process.exitCode = 1;
    }
  });
  process.on("disconnect", () => {
    void app?.close().finally(() => process.exit());
  });
}

function options(args) {
  const out = { api: "http://127.0.0.1:8000", start: false, help: false };
  for (const arg of args) {
    if (arg === "--start-backend") out.start = true;
    else if (arg === "--help") out.help = true;
    else if (arg.startsWith("--api=")) out.api = arg.slice(6);
    else throw new Error("Unsupported argument. Use --help.");
  }
  const url = new URL(out.api);
  assert.ok(
    url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
    "Only local HTTP API origins are supported.",
  );
  assert.ok(
    !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/",
    "Pass an origin without credentials, path, query or fragment.",
  );
  if (out.start) {
    assert.equal(
      url.hostname,
      "127.0.0.1",
      "Owned backend binds only 127.0.0.1.",
    );
    assert.ok(
      !["4010", "5173", ""].includes(url.port),
      "Choose an explicit separate backend port, such as 8000 or 4011.",
    );
  }
  return { ...out, api: url.origin, port: Number(url.port || 80) };
}

async function availablePort(port) {
  const probe = createServer();
  await new Promise((done, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", done);
  });
  await new Promise((done, reject) =>
    probe.close((error) => (error ? reject(error) : done())),
  );
}

function publicOnly(value, token) {
  const visit = (item) => {
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      assert.ok(!forbidden.test(key), "Private field in public response.");
      visit(child);
    }
  };
  visit(value);
  if (token)
    assert.ok(
      !JSON.stringify(value).includes(token),
      "Credential in public response.",
    );
}

function sandboxOnly(value) {
  if (!value || typeof value !== "object") return;
  if ("executionMode" in value)
    assert.equal(value.executionMode, "MOCK", "Refuse non-MOCK response.");
  if ("transactionHash" in value)
    assert.equal(
      value.transactionHash,
      null,
      "Sandbox response must not contain a real transaction.",
    );
  if ("authorizationStatus" in value)
    assert.notEqual(
      value.authorizationStatus,
      "SIGNED_TESTNET",
      "Refuse TESTNET signature metadata.",
    );
  for (const child of Object.values(value)) sandboxOnly(child);
}

async function sourceIdentity() {
  const files = [
    "src/server.ts",
    "src/service.ts",
    "src/agents/workflow.ts",
    "src/agents/provider.ts",
    "src/storage.ts",
    "src/signer/ipc.ts",
    "src/signer/worker.ts",
    "package.json",
  ];
  return Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        sha256(await readFile(join(backendRoot, file))),
      ]),
    ),
  );
}

async function startBackend(config, runRoot, token, version, contractHash) {
  const lock = JSON.parse(
    await readFile(join(backendRoot, "contract.lock.json"), "utf8"),
  );
  assert.equal(lock.status, "ready", "Backend contract is not published.");
  assert.equal(
    lock.contract_version,
    version,
    "Backend contract version differs.",
  );
  assert.equal(lock.sha256, contractHash, "Backend contract lock differs.");
  assert.equal(
    sha256(await readFile(join(backendRoot, "vendor/contract/openapi.json"))),
    contractHash,
    "Backend snapshot hash differs.",
  );
  await availablePort(config.port);
  const requireBackend = createRequire(join(backendRoot, "package.json"));
  const loader = pathToFileURL(requireBackend.resolve("tsx")).href;
  const env = Object.fromEntries(
    [
      "PATH",
      "Path",
      "SystemRoot",
      "WINDIR",
      "TEMP",
      "TMP",
      "USERPROFILE",
      "LOCALAPPDATA",
    ]
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
  Object.assign(env, {
    NODE_ENV: "test",
    MOTION_EXECUTION_MODE: "MOCK",
    MOTION_LLM_BASE_URL: "",
    MOTION_LLM_API_KEY: "",
    MOTION_LLM_MODEL: "",
  });
  const child = fork(self, ["--backend-child"], {
    cwd: backendRoot,
    execArgv: ["--import", loader],
    env,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  let ready = false;
  try {
    await new Promise((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Backend startup exceeded 15 seconds.")),
        15_000,
      );
      const fail = () => {
        clearTimeout(timer);
        reject(new Error("Backend process exited before readiness."));
      };
      child.once("exit", fail);
      child.once("error", fail);
      child.on("message", (message) => {
        if (message?.type === "ready") {
          ready = true;
          clearTimeout(timer);
          child.off("exit", fail);
          child.off("error", fail);
          done();
        }
        if (message?.type === "failed") {
          clearTimeout(timer);
          reject(
            new Error(
              "Backend could not start safely; inspect its owner checks.",
            ),
          );
        }
      });
      child.send({
        type: "start",
        port: config.port,
        dbPath: join(runRoot, "state.sqlite"),
        token,
      });
    });
  } catch (error) {
    if (child.connected) child.send({ type: "stop" });
    await pause(200);
    if (child.exitCode === null) child.kill();
    throw error;
  }
  return {
    pid: child.pid,
    ready,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      let closed = false;
      const exited = new Promise((done) => child.once("exit", done));
      const timer = setTimeout(() => child.kill(), 10_000);
      child.on("message", (message) => {
        if (message?.type === "closed") closed = true;
      });
      child.send({ type: "stop" });
      await exited;
      clearTimeout(timer);
      return closed;
    },
  };
}

async function main() {
  const config = options(process.argv.slice(2));
  if (config.help) {
    console.log(
      "node scripts/backend-smoke.mjs --start-backend --api=http://127.0.0.1:8000\nnode scripts/backend-smoke.mjs --api=http://127.0.0.1:8000\nExisting server token: MOTION_SMOKE_OPERATOR_TOKEN environment variable. Never pass tokens in arguments.\nStarts only an isolated MOCK provider; creates a task and simulated payment. Writes ignored artifacts; owned backend closes on completion.",
    );
    return;
  }
  const verified = verifyContract();
  const runId = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
  const runRoot = join(projectRoot, "artifacts/backend-integration", runId);
  await mkdir(runRoot, { recursive: true });
  const reportPath = join(runRoot, "report.json");
  const token = config.start
    ? `smoke-${randomUUID()}`
    : process.env.MOTION_SMOKE_OPERATOR_TOKEN || "";
  const report = {
    startedAt: new Date().toISOString(),
    displayTimezone: "Asia/Shanghai",
    apiOrigin: config.api,
    layer: config.start
      ? "real-backend-public-http-with-isolated-mock-state"
      : "attached-public-http-provider-identity-unverified",
    contractVersion: verified.contractVersion,
    openapiSha256: verified.openapiSha256,
    backendImplementationVerified: config.start,
    executionMode: "MOCK",
    llmInvoked: "not_verified_for_attached_server",
    chainPaymentVerified: false,
    pass: false,
    operations: [],
    httpCalls: 0,
    eventsValidated: 0,
    noScenarioControlHeader: true,
  };
  let owned;
  const abortAll = new AbortController();
  const onSignal = () => abortAll.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const spec = JSON.parse(
      await readFile(join(projectRoot, "vendor/contract/openapi.json"), "utf8"),
    );
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    ajv.addSchema({ $id: "motion-smoke", components: spec.components });
    const validators = new Map();
    const validate = (schema, value) => {
      if (!validators.has(schema))
        validators.set(
          schema,
          ajv.compile({ $ref: `motion-smoke#/components/schemas/${schema}` }),
        );
      const check = validators.get(schema);
      assert.ok(check(value), `Response violates published ${schema} schema.`);
      publicOnly(value, token);
      sandboxOnly(value);
    };
    const headers = () => ({
      "X-Contract-Version": verified.contractVersion,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    });
    const checkHeaders = (response) => {
      assert.equal(
        response.headers.get("X-Contract-Version"),
        verified.contractVersion,
        "Response contract version differs.",
      );
      assert.equal(
        response.headers.get("X-Execution-Mode"),
        "MOCK",
        "Refuse a provider that is not explicitly MOCK.",
      );
    };
    async function request(operation, method, path, schema, body, etag) {
      if (abortAll.signal.aborted) throw new Error("Smoke interrupted.");
      const response = await fetch(`${config.api}/api/v1${path}`, {
        method,
        headers: {
          ...headers(),
          ...(method === "POST"
            ? {
                "Content-Type": "application/json",
                "Idempotency-Key": `smoke:${randomUUID()}`,
                ...(etag ? { "If-Match": etag } : {}),
              }
            : {}),
        },
        ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.any([abortAll.signal, AbortSignal.timeout(10_000)]),
        redirect: "error",
      });
      report.httpCalls++;
      checkHeaders(response);
      assert.match(
        response.headers.get("Content-Type") || "",
        /^application\/json(?:;|$)/i,
        "JSON response required.",
      );
      const value = await response.json();
      if (!response.ok) {
        validate("ApiError", value);
        throw new Error(
          `${operation} returned HTTP ${response.status} (${value.error.code}).`,
        );
      }
      const operationSpec = Object.values(spec.paths)
        .flatMap((item) => Object.values(item))
        .find((item) => item.operationId === operation);
      assert.ok(
        operationSpec?.responses?.[String(response.status)],
        `${operation} returned an undeclared status.`,
      );
      assert.match(
        response.headers.get("ETag") || "",
        strongEtag,
        "Strong ETag required.",
      );
      validate(schema, value);
      if (value.etag)
        assert.equal(
          value.etag,
          response.headers.get("ETag"),
          "ETag differs from body.",
        );
      if (!report.operations.includes(operation))
        report.operations.push(operation);
      return value;
    }
    const get = (operation, path, schema) =>
      request(operation, "GET", path, schema);
    const post = (operation, path, schema, body, etag) =>
      request(operation, "POST", path, schema, body, etag);
    if (config.start) {
      report.backendSourceBefore = await sourceIdentity();
      owned = await startBackend(
        config,
        runRoot,
        token,
        verified.contractVersion,
        verified.openapiSha256,
      );
      report.ownedBackendPid = owned.pid;
      report.llmInvoked = false;
      report.modelMode = "DETERMINISTIC_SANDBOX";
    }
    const catalog = await get("getCatalog", "/catalog", "Catalog");
    assert.ok(catalog.vendors.length > 0, "Trusted catalog has no vendors.");
    const input = {
      goal: "本地后端联调检查：按冻结计划购买选定可信商家的资料。",
      allowedVendorIds: [catalog.vendors[0].vendorId],
      budgetAtomic: "1000000",
      maxPaidCalls: 1,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    validate("CreateTask", input);
    let task = await post("createTask", "/tasks", "TaskSnapshot", input);
    report.taskId = task.taskId;
    report.authMode = task.authMode;
    const taskPath = `/tasks/${encodeURIComponent(task.taskId)}`;
    assert.equal(task.status, "DRAFT");
    await post("planTask", `${taskPath}/plan`, "TaskSnapshot", {}, task.etag);
    async function waitFor(expected) {
      const deadline = Date.now() + 15_000;
      do {
        task = await get("getTask", taskPath, "TaskSnapshot");
        if (task.status === expected) return task;
        if (
          [
            "FAILED",
            "CANCELLED",
            "PAUSED_REVIEW",
            "AWAITING_SETTLEMENT",
            "COMPLETED",
          ].includes(task.status)
        )
          throw new Error(
            `Expected ${expected}; provider reached ${task.status}.`,
          );
        await pause(100);
      } while (Date.now() < deadline);
      throw new Error(`Task did not reach ${expected} within 15 seconds.`);
    }
    await waitFor("AWAITING_AUTHORIZATION");
    const plan = await get(
      "getResourcePlan",
      `${taskPath}/resource-plan`,
      "ResourcePlan",
    );
    assert.equal(plan.planHash, task.planHash);
    task = await post(
      "authorizeTask",
      `${taskPath}/authorize`,
      "TaskSnapshot",
      { planHash: plan.planHash },
      task.etag,
    );
    assert.equal(task.status, "READY");
    const frozen = await get(
      "getResourcePlan",
      `${taskPath}/resource-plan`,
      "ResourcePlan",
    );
    assert.equal(frozen.status, "FROZEN");
    assert.equal(frozen.planHash, plan.planHash);
    task = await post(
      "runTask",
      `${taskPath}/runs`,
      "TaskSnapshot",
      { authorizationVersion: task.authorization.version },
      task.etag,
    );
    await waitFor("COMPLETED");
    const budget = await get("getBudget", `${taskPath}/budget`, "BudgetView");
    assert.equal(
      BigInt(budget.settledAtomic) +
        BigInt(budget.reservedAtomic) +
        BigInt(budget.outstandingAtomic) +
        BigInt(budget.availableAtomic),
      BigInt(budget.limitAtomic),
      "Budget categories do not sum to limit.",
    );
    assert.ok(
      BigInt(budget.settledAtomic) > 0n,
      "Normal sandbox purchase did not settle.",
    );
    const payments = await get(
      "listPayments",
      `${taskPath}/payments`,
      "PaymentList",
    );
    assert.ok(payments.items.length > 0, "No payment was exposed.");
    let evidenceCount = 0;
    for (const payment of payments.items) {
      assert.equal(payment.taskId, task.taskId);
      const paymentPath = `${taskPath}/payments/${encodeURIComponent(payment.paymentId)}`;
      const detail = await get("getPayment", paymentPath, "PaymentView");
      assert.equal(detail.state, "SETTLED");
      assert.equal(detail.receipt.status, "SIMULATED");
      const decision = await get(
        "getDecision",
        `${paymentPath}/decision`,
        "DecisionView",
      );
      for (const evidenceId of decision.evidenceIds) {
        await get(
          "getEvidence",
          `${taskPath}/evidence/${encodeURIComponent(evidenceId)}`,
          "EvidenceSummary",
        );
        evidenceCount++;
      }
    }
    const reviews = await get(
      "listReviews",
      `${taskPath}/reviews`,
      "ReviewList",
    );
    assert.equal(
      reviews.items.filter((review) => review.status === "PENDING").length,
      0,
      "Normal smoke left a pending review.",
    );
    await get("listLessons", `${taskPath}/lessons`, "LessonList");
    const cursor = Math.max(0, task.lastEventSeq - 2);
    const streamAbort = new AbortController();
    const stream = await fetch(`${config.api}/api/v1${taskPath}/events`, {
      headers: { ...headers(), "Last-Event-ID": `${task.taskId}:${cursor}` },
      signal: AbortSignal.any([
        streamAbort.signal,
        abortAll.signal,
        AbortSignal.timeout(8_000),
      ]),
      redirect: "error",
    });
    checkHeaders(stream);
    assert.equal(stream.status, 200);
    assert.match(
      stream.headers.get("Content-Type") || "",
      /^text\/event-stream(?:;|$)/i,
    );
    const reader = stream.body.getReader(),
      decoder = new TextDecoder();
    let buffer = "",
      seq = cursor;
    try {
      while (seq < task.lastEventSeq) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false, "SSE ended before expected replay.");
        buffer += decoder.decode(chunk.value, { stream: true });
        assert.ok(buffer.length < 1_048_576, "SSE frame too large.");
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const lines = frame.split(/\r?\n/),
            data = lines
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
          if (!data) continue;
          const event = JSON.parse(data);
          validate("EventEnvelope", event);
          assert.equal(event.taskId, task.taskId);
          assert.equal(event.eventId, `${task.taskId}:${event.seq}`);
          assert.equal(
            lines
              .find((line) => line.startsWith("id:"))
              ?.slice(3)
              .trim(),
            event.eventId,
          );
          assert.equal(
            lines
              .find((line) => line.startsWith("event:"))
              ?.slice(6)
              .trim(),
            event.type,
          );
          assert.equal(
            event.seq,
            seq + 1,
            "SSE replay has a gap or duplicate.",
          );
          seq = event.seq;
          report.eventsValidated++;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      streamAbort.abort();
    }
    report.operations.push("streamTaskEvents");
    report.httpCalls++;
    report.finalStatus = task.status;
    report.budget = budget;
    report.payments = payments.items.map((item) => ({
      paymentId: item.paymentId,
      state: item.state,
      executionMode: item.executionMode,
      authorizationStatus: item.authorizationStatus,
      receiptStatus: item.receipt.status,
      transactionHash: item.receipt.transactionHash,
    }));
    report.evidenceValidated = evidenceCount;
    if (config.start) {
      report.backendSourceAfter = await sourceIdentity();
      report.backendSourceStable =
        JSON.stringify(report.backendSourceBefore) ===
        JSON.stringify(report.backendSourceAfter);
      assert.ok(
        report.backendSourceStable,
        "Backend source changed during the smoke; repeat after owner finishes.",
      );
    }
    report.pass = true;
  } catch (error) {
    const candidate =
      typeof error?.message === "string"
        ? error.message
        : "Backend smoke failed.";
    report.failure =
      token && candidate.includes(token)
        ? "Backend smoke failed; private value omitted."
        : candidate.slice(0, 500);
    process.exitCode = 1;
  } finally {
    abortAll.abort();
    if (owned) {
      report.ownedBackendClosed = await owned.stop();
      if (!report.ownedBackendClosed) {
        report.pass = false;
        process.exitCode = 1;
        report.failure ||= "Owned backend did not confirm graceful close.";
      }
    }
    report.finishedAt = new Date().toISOString();
    publicOnly(report, token);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    console.log(
      JSON.stringify(
        {
          pass: report.pass,
          layer: report.layer,
          apiOrigin: report.apiOrigin,
          taskId: report.taskId,
          operations: report.operations.length,
          eventsValidated: report.eventsValidated,
          ownedBackendPid: report.ownedBackendPid,
          ownedBackendClosed: report.ownedBackendClosed,
          report: reportPath,
          ...(report.failure ? { failure: report.failure } : {}),
        },
        null,
        2,
      ),
    );
  }
}

if (process.argv.includes("--backend-child")) await backendChild();
else
  await main().catch(() => {
    console.error(
      "Backend smoke setup failed. Check CLI options, local dependencies and published snapshots.",
    );
    process.exitCode = 1;
  });
