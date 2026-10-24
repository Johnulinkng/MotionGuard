import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { projectRoot, verifyContract } from "./check-contract.mjs";

const SCENARIOS = new Set(["normal", "blocked", "review", "unknown", "lesson"]);

export function mockOptions(argv = []) {
  const options = { port: 4010, scenario: "normal", check: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--check") {
      options.check = true;
      continue;
    }
    const match = argument.match(/^--(port|scenario)(?:=(.*))?$/);
    if (!match) throw new Error(`Unknown mock option: ${argument}`);
    const value = match[2] ?? argv[++index];
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for --${match[1]}.`);
    if (match[1] === "port") {
      if (
        !/^[0-9]+$/.test(value) ||
        !Number.isInteger(Number(value)) ||
        Number(value) < 1 ||
        Number(value) > 65535
      ) {
        throw new Error("Mock port must be an integer between 1 and 65535.");
      }
      options.port = Number(value);
    } else {
      if (!SCENARIOS.has(value))
        throw new Error(`Unknown mock scenario: ${value}`);
      options.scenario = value;
    }
  }
  return options;
}

export function startMock(options) {
  const args = [
    resolve(projectRoot, "vendor/contract/mock-server.mjs"),
    `--port=${options.port}`,
    `--scenario=${options.scenario}`,
    ...(options.check ? ["--check"] : []),
  ];
  return spawn(process.execPath, args, {
    cwd: projectRoot,
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  });
}

/** Direct Node children keep cleanup scoped to the processes started by this command. */
export function superviseChildren(children) {
  const active = new Set(children);
  let stopping = false;
  let forceTimer;

  function stop(exitCode) {
    if (stopping) return;
    stopping = true;
    process.exitCode = exitCode;
    for (const child of active) child.kill("SIGTERM");
    forceTimer = setTimeout(() => {
      for (const child of active) child.kill("SIGKILL");
    }, 1500);
    forceTimer.unref();
  }

  for (const child of active) {
    child.once("error", (error) => {
      console.error(`Development process failed: ${error.message}`);
      active.delete(child);
      stop(1);
    });
    child.once("exit", (code, signal) => {
      active.delete(child);
      if (!stopping) stop(code ?? (signal === "SIGINT" ? 0 : 1));
      if (active.size === 0 && forceTimer) clearTimeout(forceTimer);
    });
  }
  process.once("SIGINT", () => stop(0));
  process.once("SIGTERM", () => stop(0));
  process.once("SIGHUP", () => stop(0));
  process.once("exit", () => {
    for (const child of active) child.kill("SIGTERM");
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    verifyContract();
    superviseChildren([startMock(mockOptions(process.argv.slice(2)))]);
  } catch (error) {
    console.error(`Mock startup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
