import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { projectRoot } from "./check-contract.mjs";

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const roleNames = ["worker", "threat", "consistency"];
const forbidden = /^(?:apiKey|operatorToken|operatorSessionToken|privateKey|rawSignature|signature|signedPayload|executionGrant|hiddenReasoning|chainOfThought)$/i;
const secretPattern = /\b(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{12,})/i;

function parseOptions(args) {
  const result = { api: "http://127.0.0.1:4011", taskId: "", expectedModel: "", sourceHosts: [], rpcHosts: [], timeoutMs: 300_000, help: false, checkContract: false };
  const names = { "--api": "api", "--task-id": "taskId", "--expected-model": "expectedModel" };
  for (const arg of args) {
    if (arg === "--help") result.help = true;
    else if (arg === "--check-contract") result.checkContract = true;
    else if (arg.startsWith("--source-host=")) result.sourceHosts.push(arg.slice(14).toLowerCase());
    else if (arg.startsWith("--rpc-host=")) { const host = arg.slice(11).toLowerCase(); result.rpcHosts.push(host); result.sourceHosts.push(host); }
    else if (arg.startsWith("--timeout-ms=")) result.timeoutMs = Number(arg.slice(13));
    else {
      const index = arg.indexOf("="), name = arg.slice(0, index);
      assert.ok(index > 0 && names[name], "Unknown option. Use --help.");
      result[names[name]] = arg.slice(index + 1);
    }
  }
  const url = new URL(result.api);
  assert.ok(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Use a local public API origin.");
  assert.ok(!url.username && !url.password && !url.search && !url.hash && url.pathname === "/", "API must be an origin without credentials or path.");
  assert.ok(Number.isInteger(result.timeoutMs) && result.timeoutMs >= 10_000 && result.timeoutMs <= 600_000, "Timeout must be 10000–600000 milliseconds.");
  if (!result.help && !result.checkContract) {
    assert.match(result.taskId, /^[A-Za-z][A-Za-z0-9_-]{2,63}$/, "Pass the existing browser-created task ID; this verifier never creates tasks.");
    assert.ok(result.sourceHosts.length > 0, "Provide expected --source-host values; arbitrary evidence URLs are not trusted.");
    assert.ok(result.sourceHosts.every((host) => /^[a-z0-9.-]+$/.test(host) && host.includes(".") && !host.endsWith(".local")), "Expected source hosts must be public DNS names.");
    assert.ok(result.rpcHosts.every((host) => host === "sepolia.base.org"), "Only the official public Base Sepolia host supports the fixed read-only RPC probe.");
  }
  result.api = url.origin;
  return result;
}

function assertPublic(value) {
  if (typeof value === "string") assert.ok(!secretPattern.test(value), "Public response contains a credential-shaped value; omitted from report.");
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!forbidden.test(key), "Public response contains a private field; omitted from report.");
    assertPublic(child);
  }
}

async function loadPublishedContract() {
  const lock = JSON.parse(await readFile(join(projectRoot, "contract.lock.json"), "utf8"));
  assert.equal(lock.status, "ready"); assert.equal(lock.hash_algorithm, "sha256"); assert.equal(lock.snapshot, "vendor/contract/openapi.json");
  const vendor = await realpath(join(projectRoot, "vendor/contract"));
  const bytes = await readFile(join(vendor, "openapi.json")), spec = JSON.parse(bytes.toString("utf8"));
  assert.equal(sha256(bytes), lock.sha256); assert.equal(spec.info.version, lock.contract_version); assert.equal(spec.openapi, "3.1.0");
  const manifest = JSON.parse(await readFile(join(vendor, "release-manifest.json"), "utf8"));
  assert.equal(manifest.contract_version, lock.contract_version); assert.equal(manifest.sha256, lock.sha256); assert.equal(manifest.bundle_sha256, lock.bundle_sha256);
  assert.ok(Array.isArray(manifest.files) && manifest.files.length); assert.equal(sha256(JSON.stringify(manifest.files)), lock.bundle_sha256);
  const seen = new Set();
  for (const entry of manifest.files) {
    assert.ok(typeof entry.path === "string" && !isAbsolute(entry.path) && !entry.path.includes("\\") && !entry.path.includes(":") && entry.path.split("/").every((part) => part && part !== "." && part !== ".."));
    assert.ok(!seen.has(entry.path)); seen.add(entry.path);
    const file = await realpath(resolve(vendor, entry.path)), within = relative(vendor, file);
    assert.ok(!isAbsolute(within) && within !== ".." && !within.startsWith(`..${sep}`));
    assert.equal(sha256(await readFile(file)), entry.sha256, `Published file hash differs: ${entry.path}`);
  }
  assert.ok(spec.components.schemas.TaskResult && spec.paths["/api/v1/tasks/{taskId}/result"]?.get, "Published TaskResult is unavailable; do not verify an old provider.");
  return { spec, contractVersion: lock.contract_version, openapiSha256: lock.sha256, bundleSha256: lock.bundle_sha256, verifiedFiles: seen.size };
}

async function verifySourceReachability(url, rpcHosts) {
  const rpc = rpcHosts.includes(new URL(url).hostname.toLowerCase());
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000), method: rpc ? "POST" : "GET", headers: { "User-Agent": "MotionGuard-public-source-verification/0.1", ...(rpc ? { "Content-Type": "application/json" } : {}) }, ...(rpc ? { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) } : {}) });
  const reader = response.body?.getReader();
  const chunks = [];
  let size = 0;
  try {
    if (reader) while (true) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.length; assert.ok(size <= 2_097_152, "Source body exceeds independent verification limit."); chunks.push(item.value);
    }
  } finally { await reader?.cancel().catch(() => {}); }
  const body = Buffer.concat(chunks);
  const value = JSON.parse(body.toString("utf8")), host = new URL(url).hostname;
  let dataSummary;
  if (rpc) {
    assert.equal(value.result?.toLowerCase(), "0x14a34", "Expected the Base Sepolia chain, not a payment or arbitrary RPC method.");
    dataSummary = { chainId: 84532, network: "Base Sepolia testnet" };
  } else if (host === "coins.llama.fi") {
    const quote = value.coins?.["coingecko:ethereum"];
    assert.ok(quote && Number.isFinite(quote.price) && quote.price > 0 && Number.isFinite(quote.timestamp) && quote.timestamp > 0, "ETH price source returned no valid price/timestamp payload.");
    dataSummary = { symbol: quote.symbol, ethUsd: quote.price, providerTimestamp: new Date(quote.timestamp * 1000).toISOString() };
  } else if (host === "api.llama.fi") {
    assert.ok(Array.isArray(value), "Chain TVL source returned no JSON array.");
    const selected = ["Ethereum", "Base"].map((name) => value.find((row) => row.name === name));
    assert.ok(selected.every((row) => row && Number.isFinite(row.tvl) && row.tvl >= 0) && Number(selected[0].chainId) === 1 && Number(selected[1].chainId) === 8453, "Expected Ethereum/Base mainnet TVL records are unavailable.");
    dataSummary = selected.map((row) => ({ name: row.name, chainId: row.chainId, tvlUsd: row.tvl, providerTimestamp: "not provided" }));
  } else throw new Error("No independent payload validator is registered for the declared source host.");
  return { url, method: rpc ? "eth_chainId (read only)" : "GET", status: response.status, contentType: response.headers.get("Content-Type"), jsonPayloadVerified: true, dataSummary, bytes: size, rawBodySha256: sha256(body), checkedAt: new Date().toISOString() };
}

async function main() {
  const config = parseOptions(process.argv.slice(2));
  if (config.help) {
    console.log("Verify the existing real-model task:\nnode scripts/real-model-smoke.mjs --task-id=task_ID --source-host=coins.llama.fi --source-host=api.llama.fi --rpc-host=sepolia.base.org\nOptional --api=ORIGIN --expected-model=ACTUAL_RESPONSE_MODEL --timeout-ms=300000\nUses the published structured TaskResult, evidence and SSE; never creates a task or sends a mutation/model request. No .env, model key or X-Mock-Scenario. Optional operator bearer: MOTION_SMOKE_OPERATOR_TOKEN env.\n--rpc-host permits only a fixed read-only Base Sepolia eth_chainId check; no transaction/signature RPC.\nRequires worker selection/report, threat and consistency success, LIVE_HTTP sources, NO_ONLINE_LABELS, no task promotion, zero payments and no hidden fallback. Failures remain in ignored artifacts/real-model.");
    return;
  }
  const locked = await loadPublishedContract();
  if (config.checkContract) {
    console.log(JSON.stringify({ contractVersion: locked.contractVersion, openapiSha256: locked.openapiSha256, bundleSha256: locked.bundleSha256, verifiedFiles: locked.verifiedFiles, publicApiContacted: false }, null, 2));
    return;
  }
  const runRoot = join(projectRoot, "artifacts/real-model", `${new Date().toISOString().replaceAll(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`);
  await mkdir(runRoot, { recursive: true });
  const report = { startedAt: new Date().toISOString(), timezone: "Asia/Shanghai", apiOrigin: config.api, contractVersion: locked.contractVersion, contractSha256: locked.openapiSha256, bundleSha256: locked.bundleSha256, verifiedFiles: locked.verifiedFiles, scope: "public-api-real-model-free-source-verification", requiredRoles: roleNames, expectedModel: config.expectedModel || null, expectedSourceHosts: config.sourceHosts, mutations: 0, modelCallsIssuedByVerifier: 0, noScenarioControlHeader: true, realChainPaymentVerified: false, pass: false, failures: [], requests: [], events: [], evidence: [], checks: {} };
  const token = process.env.MOTION_SMOKE_OPERATOR_TOKEN || "";
  const abort = new AbortController();
  const onSignal = () => abort.abort();
  process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
  let streamPromise;
  try {
    const spec = locked.spec;
    const ajv = new Ajv2020({ strict: false }); addFormats(ajv); ajv.addSchema({ $id: "real-model-smoke", components: spec.components });
    const validators = new Map();
    const validate = (schema, value) => {
      if (!validators.has(schema)) validators.set(schema, ajv.compile({ $ref: `real-model-smoke#/components/schemas/${schema}` }));
      assert.ok(validators.get(schema)(value), `Public response violates ${schema}.`); assertPublic(value);
      if (token) assert.ok(!JSON.stringify(value).includes(token), "Operator credential appeared in public response.");
    };
    const headers = () => ({ "X-Contract-Version": locked.contractVersion, ...(token ? { Authorization: `Bearer ${token}` } : {}) });
    const checkHeaders = (response) => {
      assert.equal(response.headers.get("X-Contract-Version"), locked.contractVersion, "Contract version differs.");
      assert.equal(response.headers.get("X-Execution-Mode"), "MOCK", "Payment mode must remain MOCK during real-model/free-source verification.");
    };
    async function get(path, schema) {
      const response = await fetch(`${config.api}/api/v1${path}`, { headers: headers(), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]), redirect: "error" });
      report.requests.push({ method: "GET", path, status: response.status }); checkHeaders(response);
      assert.match(response.headers.get("Content-Type") || "", /^application\/json(?:;|$)/i);
      const value = await response.json(); validate(response.ok ? schema : "ApiError", value);
      assert.ok(response.ok, `GET ${path} returned ${response.status} (${value?.error?.code ?? "UNKNOWN"}).`);
      assert.match(response.headers.get("ETag") || "", /^"[A-Za-z0-9_:-]+"$/);
      if (value.etag) assert.equal(value.etag, response.headers.get("ETag"));
      return value;
    }
    report.catalog = await get("/catalog", "Catalog");
    let task = await get(`/tasks/${config.taskId}`, "TaskSnapshot");
    report.taskId = task.taskId;
    const path = `/tasks/${encodeURIComponent(task.taskId)}`;
    let streamFailure;
    streamPromise = (async () => {
      const response = await fetch(`${config.api}/api/v1${path}/events`, { headers: { ...headers(), "Last-Event-ID": `${task.taskId}:0` }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(config.timeoutMs + 15_000)]), redirect: "error" });
      checkHeaders(response); assert.equal(response.status, 200, "Event replay failed."); assert.match(response.headers.get("Content-Type") || "", /^text\/event-stream(?:;|$)/i);
      report.checks.sseResponseValidated = true;
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "", seq = 0;
      try {
        while (!abort.signal.aborted) {
          const chunk = await reader.read(); if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true }); assert.ok(buffer.length < 1_048_576, "Oversized public SSE frame.");
          let boundary;
          while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
            const lines = frame.split(/\r?\n/), data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n"); if (!data) continue;
            const event = JSON.parse(data); validate("EventEnvelope", event);
            assert.equal(event.taskId, task.taskId); assert.equal(event.eventId, `${task.taskId}:${event.seq}`);
            assert.equal(lines.find((line) => line.startsWith("id:"))?.slice(3).trim(), event.eventId);
            assert.equal(lines.find((line) => line.startsWith("event:"))?.slice(6).trim(), event.type);
            assert.equal(event.seq, seq + 1, "SSE event replay has a gap or duplicate."); seq = event.seq; report.events.push(event);
          }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    })().catch((error) => { if (!abort.signal.aborted) streamFailure = error instanceof Error ? error.message : "SSE failed."; });
    async function waitFor(states) {
      const deadline = Date.now() + config.timeoutMs;
      while (true) {
        task = await get(path, "TaskSnapshot");
        if (states.includes(task.status) || ["FAILED", "CANCELLED", "PAUSED_REVIEW", "AWAITING_SETTLEMENT", "COMPLETED"].includes(task.status)) return task;
        assert.ok(Date.now() < deadline, "Real-model task exceeded the bounded wait."); await pause(500);
      }
    }
    await waitFor(["COMPLETED"]); report.task = task;
    const resultDeadline = Date.now() + 10_000;
    while (!report.result) {
      try { report.result = await get(`${path}/result`, "TaskResult"); }
      catch (error) { if (!String(error?.message).includes("409 (RESULT_NOT_READY)") || Date.now() >= resultDeadline) throw error; await pause(250); }
    }
    report.budget = await get(`${path}/budget`, "BudgetView");
    report.payments = await get(`${path}/payments`, "PaymentList");
    report.reviews = await get(`${path}/reviews`, "ReviewList");
    report.lessons = await get(`${path}/lessons`, "LessonList");
    const streamDeadline = Date.now() + 20_000;
    while (!streamFailure && (report.events.at(-1)?.seq ?? 0) < task.lastEventSeq && Date.now() < streamDeadline) await pause(100);
    if (streamFailure) report.failures.push(streamFailure);
    report.checks.sseReachesSnapshot = report.events.at(-1)?.seq === task.lastEventSeq;
    if (!report.checks.sseReachesSnapshot) report.failures.push("Public SSE replay did not reach the final task snapshot.");
    assert.equal(report.result.taskId, task.taskId);
    const candidates = new Set(report.result.evidenceIds);
    if (report.result.sources.some((source) => !candidates.has(source.evidenceId))) report.failures.push("A source evidence ID is missing from TaskResult.evidenceIds.");
    const seen = new Set();
    while (candidates.size) {
      assert.ok(seen.size < 300, "Public evidence graph exceeds smoke limit.");
      const id = candidates.values().next().value; candidates.delete(id); if (seen.has(id)) continue; seen.add(id);
      const evidence = await get(`${path}/evidence/${encodeURIComponent(id)}`, "EvidenceSummary"); assert.equal(evidence.taskId, task.taskId); report.evidence.push(evidence);
      for (const parent of evidence.parentIds) if (!seen.has(parent)) candidates.add(parent);
      for (const done of seen) candidates.delete(done);
    }
    const result = report.result;
    if (result.status !== "COMPLETED") report.failures.push(`TaskResult ended ${result.status}.`);
    if (result.model.mode !== "LIVE_API" || result.dataMode !== "LIVE_HTTP") report.failures.push("TaskResult does not identify both real model API and live HTTP data.");
    if (result.paymentMode !== "MOCK" || result.paidCalls !== 0) report.failures.push("Free public sources must not create paid calls or claim real payment.");
    if (result.learningMode !== "NO_ONLINE_LABELS") report.failures.push("Live data used sandbox-oracle labels or online learning.");
    if (result.report.trim().length < 40) report.failures.push("No substantive visible report was returned.");
    report.modelDiagnostics = result.model.diagnostics;
    report.modelProof = result.model.diagnostics.filter((call) => call.status === "SUCCEEDED" && call.httpStatus === 200 && typeof call.actualModel === "string" && call.actualModel);
    const successfulRoles = new Set(report.modelProof.map((item) => item.role));
    report.checks.successfulRoles = [...successfulRoles];
    for (const role of roleNames) if (!successfulRoles.has(role)) report.failures.push(`No public successful real-model metadata for ${role}.`);
    if (!report.modelProof.some((call) => call.role === "worker" && call.phase === "report")) report.failures.push("No successful real worker report-generation call.");
    if (!report.modelProof.some((call) => call.role === "worker" && call.phase === "select")) report.failures.push("No successful real worker selection call.");
    if (result.model.diagnostics.some((call) => call.status === "FAILED" || call.errorCategory)) report.failures.push("A model call failed; fallback cannot be hidden as a successful task.");
    if (config.expectedModel && report.modelProof.some((item) => item.actualModel !== config.expectedModel)) report.failures.push("Returned actual model differs from the explicitly expected model.");
    if (!config.expectedModel && report.modelProof.some((item) => !/deepseek/i.test(item.actualModel))) report.failures.push("Successful call metadata does not identify a DeepSeek response model.");
    const publicText = JSON.stringify({ task: report.task, result, events: report.events, evidence: report.evidence });
    if (/MODEL_CHECK_UNAVAILABLE|MODEL_HTTP_FAILURE|MODEL_OUTPUT_FAILURE|INVALID_MODEL_JUDGMENT|DETERMINISTIC_SANDBOX|sandbox data only|deterministic fallback/i.test(publicText)) report.failures.push("Public task contains failed model validation or deterministic/sandbox fallback evidence.");
    if (task.status !== "COMPLETED") report.failures.push(`Task ended ${task.status}; no review was approved automatically.`);
    if (!report.evidence.some((item) => item.sourceKind === "TOOL_RESPONSE" && item.trust === "EXTERNAL_UNTRUSTED")) report.failures.push("No reachable untrusted TOOL_RESPONSE evidence.");
    if (!report.evidence.some((item) => item.sourceKind === "MODEL_OUTPUT")) report.failures.push("No reachable MODEL_OUTPUT evidence.");
    const byId = new Map(report.evidence.map((item) => [item.evidenceId, item]));
    report.checks.sourceEvidenceHashesMatch = true;
    for (const source of result.sources) {
      const evidence = byId.get(source.evidenceId);
      if (!evidence || evidence.sourceKind !== "TOOL_RESPONSE" || evidence.trust !== "EXTERNAL_UNTRUSTED") report.failures.push("A TaskResult source lacks a registered untrusted TOOL_RESPONSE.");
      if (!evidence || evidence.contentHash !== source.contentHash || !evidence.excerpt.includes(source.url)) report.checks.sourceEvidenceHashesMatch = false;
    }
    if (!report.checks.sourceEvidenceHashesMatch) report.failures.push("A structured source hash or URL is not bound to the fetched public evidence.");
    const reportHash = `sha256:${sha256(JSON.stringify(result.report))}`;
    const reportEvidence = report.evidence.filter((item) => item.sourceKind === "MODEL_OUTPUT" && item.contentHash === reportHash && item.excerpt === result.report.slice(0, 1200));
    report.checks.reportHashMatchesEvidence = reportEvidence.length > 0;
    if (!report.checks.reportHashMatchesEvidence) report.failures.push("The visible report is not bound by hash to a host-registered MODEL_OUTPUT.");
    const refs = [...result.report.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
    const validRefs = refs.length > 0 && refs.every((index) => index >= 1 && index <= result.sources.length);
    const citedIds = validRefs ? [...new Set(refs.map((index) => result.sources[index - 1].evidenceId))] : [];
    report.checks.reportCitationsBoundToSources = validRefs && reportEvidence.some((record) => {
      const parents = [...record.parentIds], seenParents = new Set();
      while (parents.length) { const id = parents.pop(); if (seenParents.has(id)) continue; seenParents.add(id); parents.push(...(byId.get(id)?.parentIds ?? [])); }
      return citedIds.every((id) => seenParents.has(id));
    });
    if (!report.checks.reportCitationsBoundToSources) report.failures.push("The report's source citations are invalid or outside its recorded consumed-source parent closure.");
    report.sourceProof = result.sources;
    if (!report.sourceProof.length) report.failures.push("No structured real-source provenance with URL, timestamp and hash.");
    report.sourceReachability = [];
    const sourceProbes = await Promise.all([...new Set(report.sourceProof.map((item) => item.url))].map(async (url) => {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || !config.sourceHosts.includes(parsed.hostname.toLowerCase())) return { url, failure: "A real source is outside the explicitly expected HTTPS hosts." };
      try { return { check: await verifySourceReachability(url, config.rpcHosts) }; }
      catch { return { url, failure: "Independent public-source fetch failed; real-source reachability remains unverified." }; }
    }));
    for (const probe of sourceProbes) {
      if (probe.failure) { report.failures.push(probe.failure); report.sourceReachability.push({ url: probe.url, status: null, failure: probe.failure, checkedAt: new Date().toISOString() }); continue; }
      report.sourceReachability.push(probe.check);
      if (probe.check.status !== 200 || probe.check.bytes === 0) report.failures.push("An expected real source was not independently reachable with a nonempty HTTP 200 body.");
    }
    const budget = report.budget;
    report.checks.budgetConserved = BigInt(budget.settledAtomic) + BigInt(budget.reservedAtomic) + BigInt(budget.outstandingAtomic) + BigInt(budget.availableAtomic) === BigInt(budget.limitAtomic);
    if (!report.checks.budgetConserved) report.failures.push("Budget does not conserve atomic units.");
    if (report.payments.items.length || budget.settledAtomic !== "0" || budget.reservedAtomic !== "0" || budget.outstandingAtomic !== "0" || budget.availableAtomic !== budget.limitAtomic) report.failures.push("Free public-source task created a payment or money exposure.");
    if (report.reviews.items.some((review) => review.status === "PENDING")) report.failures.push("Task left a pending review.");
    const taskEvidenceIds = new Set(result.evidenceIds);
    report.checks.noTaskLessonPromotion = !report.events.some((event) => event.type === "lesson.promoted") && !report.lessons.items.some((lesson) => lesson.status === "ACTIVE" && lesson.sourceEvidenceIds.some((id) => taskEvidenceIds.has(id)));
    if (!report.checks.noTaskLessonPromotion) report.failures.push("The live task promoted an ACTIVE lesson without trustworthy online labels.");
    report.curator = result.model.diagnostics.some((call) => call.role === "curator") ? "See actual diagnostics; not counted as a required call." : "Not run: NO_ONLINE_LABELS; no trustworthy attack label for promotion.";
    report.checks.zeroPaymentFreeSources = report.payments.items.length === 0 && budget.settledAtomic === "0";
    report.pass = report.failures.length === 0;
  } catch (error) {
    const message = typeof error?.message === "string" ? error.message : "Real-model verification failed.";
    report.failures.push(secretPattern.test(message) || (token && message.includes(token)) ? "Private-shaped failure omitted." : message.slice(0, 500));
  } finally {
    abort.abort(); await streamPromise?.catch(() => {});
    report.finishedAt = new Date().toISOString();
    assertPublic(report);
    const path = join(runRoot, "report.json"); await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal);
    if (!report.pass) process.exitCode = 1;
    console.log(JSON.stringify({ pass: report.pass, taskId: report.taskId, successfulRoles: report.checks.successfulRoles, sourceCount: report.sourceProof?.length ?? 0, paymentCount: report.payments?.items.length, settledAtomic: report.budget?.settledAtomic, failures: report.failures, report: path }, null, 2));
  }
}

await main().catch(() => { console.error("Real-model smoke setup failed. Check explicit options and the published snapshot; no secret file is read."); process.exitCode = 1; });
