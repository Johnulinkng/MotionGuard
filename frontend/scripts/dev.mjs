import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { projectRoot, verifyContract } from "./check-contract.mjs";
import { mockOptions, startMock, superviseChildren } from "./mock.mjs";

try {
  const result = verifyContract();
  const options = mockOptions(process.argv.slice(2));
  if (options.check)
    throw new Error(
      "Use npm run mock -- --check for the standalone simulator check.",
    );
  const vitePath = resolve(projectRoot, "node_modules/vite/bin/vite.js");
  if (!existsSync(vitePath))
    throw new Error(
      "Vite is not installed. Run npm ci in the frontend directory first.",
    );
  console.log(
    `Motion Guard MOCK · contract ${result.contractVersion} · scenario ${options.scenario}`,
  );
  const mock = startMock(options);
  const vite = spawn(process.execPath, [vitePath, "--host", "127.0.0.1"], {
    cwd: projectRoot,
    stdio: "inherit",
    shell: false,
    windowsHide: true,
    env: {
      ...process.env,
      MOTION_API_TARGET: `http://127.0.0.1:${options.port}`,
      VITE_SIMULATOR_CONTROLS: "true",
    },
  });
  superviseChildren([mock, vite]);
} catch (error) {
  console.error(`Development startup failed: ${error.message}`);
  process.exitCode = 1;
}
