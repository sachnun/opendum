#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));

const refreshScripts = [
  "refresh-openrouter-free-models.mjs",
  "refresh-nvidia-nim-models.mjs",
  "refresh-ollama-cloud-models.mjs",
];

function runScript(scriptName) {
  const scriptPath = resolve(scriptDir, scriptName);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: "inherit",
    });

    child.on("error", rejectPromise);
    child.on("close", (code, signal) => {
      if (signal) {
        rejectPromise(new Error(`${scriptName} exited with signal ${signal}`));
        return;
      }

      if (typeof code === "number" && code !== 0) {
        rejectPromise(new Error(`${scriptName} exited with code ${code}`));
        return;
      }

      resolvePromise();
    });
  });
}

async function main() {
  const results = await Promise.allSettled(refreshScripts.map((scriptName) => runScript(scriptName)));
  const failures = results.filter((result) => result.status === "rejected");

  if (failures.length === 0) {
    return;
  }

  for (const failure of failures) {
    const reason = failure.reason instanceof Error ? failure.reason.message : String(failure.reason);
    console.error(reason);
  }

  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
