import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer as createPortProbe } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { projectRoot, verifyContract } from "./check-contract.mjs";

const self = fileURLToPath(import.meta.url);
const backendRoot = resolve(projectRoot, "../backend");
const backendOrigin = "http://127.0.0.1:8000";
const frontendOrigin = "http://127.0.0.1:5173";
const stateRoot = join(projectRoot, "artifacts/backend-local");

function cleanEnvironment() {
  const names = [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "ComSpec",
  ];
  const env = Object.fromEntries(
    names
      .filter((name) => process.env[name])
      .map((name) => [name, process.env[name]]),
  );
  return {
    ...env,
    NODE_ENV: "development",
    MOTION_EXECUTION_MODE: "MOCK",
    MOTION_LLM_BASE_URL: "",
    MOTION_LLM_API_KEY: "",
    MOTION_LLM_MODEL: "",
    MOTION_API_TARGET: backendOrigin,
    VITE_SIMULATOR_CONTROLS: "false",
  };
}

async function childMain(role) {
  assert.equal(
    typeof process.send,
    "function",
    "Private development child requires IPC.",
  );
  let close;
  let closing;
  const shutdown = () =>
    (closing ||= (async () => {
      let closed = false;
      try {
        await close?.();
        closed = true;
      } catch {
        process.exitCode = 1;
      } finally {
        if (process.connected)
          process.send({ type: closed ? "closed" : "close-failed" }, () =>
            process.disconnect(),
          );
        else process.exit(process.exitCode || 0);
      }
    })());
  process.on("disconnect", () => {
    void shutdown().finally(() => process.exit(process.exitCode || 0));
  });
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
  process.on("message", (message) => {
    if (message?.type === "stop") void shutdown();
  });
  try {
    if (role === "--backend-child") {
      const { createApp } = await import(
        pathToFileURL(join(backendRoot, "src/server.ts")).href
      );
      const app = await createApp({
        dbPath: join(stateRoot, "state.sqlite"),
        executionMode: "MOCK",
        authRequired: false,
        allowedOrigins: [frontendOrigin, "http://localhost:5173"],
      });
      close = () => app.close();
      await new Promise((done, reject) => {
        app.server.once("error", reject);
        app.server.listen(8000, "127.0.0.1", done);
      });
    } else {
      const { createServer } = await import("vite");
      const vite = await createServer({
        configFile: join(projectRoot, "vite.config.ts"),
        root: projectRoot,
        envDir: false,
        clearScreen: false,
        server: {
          host: "127.0.0.1",
          port: 5173,
          strictPort: true,
          proxy: { "/api": { target: backendOrigin, changeOrigin: true } },
        },
      });
      close = () => vite.close();
      await vite.listen();
    }
    if (closing) {
      await close?.();
      return;
    }
    process.send({ type: "ready", pid: process.pid, role });
  } catch {
    if (process.connected) process.send({ type: "failed", role });
    await shutdown();
    process.exitCode = 1;
  }
}

async function assertPortAvailable(port) {
  const server = createPortProbe();
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", done);
  });
  await new Promise((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(
      "node scripts/dev-backend.mjs\nStarts the real backend in isolated local MOCK mode on 127.0.0.1:8000 and Vite on 127.0.0.1:5173.\nSQLite: frontend/artifacts/backend-local/state.sqlite. No .env, model, RPC, wallet or inherited secret configuration.\nCtrl+C closes owned Vite, HTTP and signer processes. Existing listeners are never replaced.",
    );
    return;
  }
  assert.equal(
    process.argv.length,
    2,
    "This launcher takes no arguments. Use --help.",
  );
  const frontendContract = verifyContract();
  const backendContract = verifyContract(backendRoot);
  assert.equal(
    backendContract.contractVersion,
    frontendContract.contractVersion,
    "Backend contract version differs.",
  );
  assert.equal(
    backendContract.openapiSha256,
    frontendContract.openapiSha256,
    "Backend OpenAPI hash differs.",
  );
  assert.equal(
    backendContract.bundleSha256,
    frontendContract.bundleSha256,
    "Backend snapshot bundle differs.",
  );
  await assertPortAvailable(8000);
  await assertPortAvailable(5173);
  const backendLoader = pathToFileURL(
    createRequire(join(backendRoot, "package.json")).resolve("tsx"),
  ).href;
  await mkdir(stateRoot, { recursive: true });
  const children = [];
  let stopping;
  async function stopChild(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    let confirmed = false;
    const exited = new Promise((done) => child.once("exit", done));
    const timer = setTimeout(() => child.kill(), 15_000);
    child.on("message", (message) => {
      if (message?.type === "closed") confirmed = true;
    });
    if (child.connected) child.send({ type: "stop" }, () => {});
    else child.kill();
    await exited;
    clearTimeout(timer);
    if (!confirmed)
      console.error(
        `Development child ${child.pid} exited without a graceful-close acknowledgment.`,
      );
  }
  const stop = (failed = false) =>
    (stopping ||= (async () => {
      if (failed) process.exitCode = 1;
      // Close the page server first, then the HTTP provider and its private signer.
      for (const child of [...children].reverse()) await stopChild(child);
    })());
  process.once("SIGINT", () => {
    void stop();
  });
  process.once("SIGTERM", () => {
    void stop();
  });
  async function start(role, execArgv = []) {
    const child = fork(self, [role], {
      cwd: role === "--backend-child" ? backendRoot : projectRoot,
      execArgv,
      env: cleanEnvironment(),
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      windowsHide: true,
    });
    children.push(child);
    child.once("exit", () => {
      if (!stopping) void stop(true);
    });
    child.on("error", () => {
      if (!stopping) void stop(true);
    });
    await new Promise((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${role} startup exceeded 20 seconds.`)),
        20_000,
      );
      const fail = () => {
        clearTimeout(timer);
        reject(new Error(`${role} exited before readiness.`));
      };
      child.once("exit", fail);
      child.once("error", fail);
      child.on("message", (message) => {
        if (message?.type === "ready") {
          clearTimeout(timer);
          child.off("exit", fail);
          child.off("error", fail);
          done();
        }
        if (message?.type === "failed") {
          clearTimeout(timer);
          reject(new Error(`${role} could not start safely.`));
        }
      });
    });
    return child;
  }
  try {
    const backend = await start("--backend-child", ["--import", backendLoader]);
    if (stopping) return;
    const vite = await start("--vite-child");
    if (stopping) return;
    assert.equal(
      backend.exitCode,
      null,
      "Backend exited during frontend startup.",
    );
    assert.equal(
      backend.signalCode,
      null,
      "Backend stopped during frontend startup.",
    );
    console.log(
      `Motion Guard · real backend / MOCK · contract ${frontendContract.contractVersion}`,
    );
    console.log(`Frontend ${frontendOrigin} · PID ${vite.pid}`);
    console.log(
      `Backend  ${backendOrigin} · PID ${backend.pid} · deterministic sandbox · loopback only`,
    );
    console.log(
      "State: frontend/artifacts/backend-local/state.sqlite · Ctrl+C closes both services.",
    );
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Local integration startup failed.",
    );
    await stop(true);
  }
}

const role = process.argv[2];
if (["--backend-child", "--vite-child"].includes(role)) await childMain(role);
else
  await main().catch(() => {
    console.error(
      "Local integration startup refused. Check snapshot integrity, backend dependencies and free ports 8000/5173.",
    );
    process.exitCode = 1;
  });
