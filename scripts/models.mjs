#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTomlIndex } from "./toml-utils.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const modelsDir = resolve(rootDir, "packages/shared/models");

const refreshScripts = [
  "openrouter.mjs",
  "nvidia.mjs",
  "ollama.mjs",
];

// Providers whose models are refreshed by the scripts above
const REFRESHED_PROVIDERS = ["nvidia_nim", "ollama_cloud", "openrouter"];

// ---------------------------------------------------------------------------
// Run a child script
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Snapshot & diff helpers — used to generate a dynamic PR summary
// ---------------------------------------------------------------------------

function snapshotProviderModels() {
  const index = buildTomlIndex(modelsDir);
  const snapshot = new Map();

  for (const provider of REFRESHED_PROVIDERS) {
    snapshot.set(provider, new Set());
  }

  for (const [modelId, entry] of Object.entries(index)) {
    const providers = entry.data.opendum?.providers || [];
    for (const provider of providers) {
      if (snapshot.has(provider)) {
        snapshot.get(provider).add(modelId);
      }
    }
  }

  return snapshot;
}

function generateSummary(before, after) {
  const added = [];
  const removed = [];

  for (const provider of REFRESHED_PROVIDERS) {
    const oldKeys = before.get(provider) ?? new Set();
    const newKeys = after.get(provider) ?? new Set();

    for (const key of newKeys) {
      if (!oldKeys.has(key)) added.push({ model: key, provider });
    }
    for (const key of oldKeys) {
      if (!newKeys.has(key)) removed.push({ model: key, provider });
    }
  }

  const sections = [];

  if (added.length) {
    const lines = added
      .sort((a, b) => a.model.localeCompare(b.model))
      .map((e) => `- \`${e.model}\` *(${e.provider})*`);
    sections.push(`### Added Models (${added.length})\n\n${lines.join("\n")}`);
  }

  if (removed.length) {
    const lines = removed
      .sort((a, b) => a.model.localeCompare(b.model))
      .map((e) => `- \`${e.model}\` *(${e.provider})*`);
    sections.push(`### Removed Models (${removed.length})\n\n${lines.join("\n")}`);
  }

  return sections.length > 0 ? sections.join("\n\n") + "\n" : "_No model changes detected._\n";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const before = snapshotProviderModels();

  const results = await Promise.allSettled(refreshScripts.map((scriptName) => runScript(scriptName)));
  const failures = results.filter((result) => result.status === "rejected");

  if (failures.length > 0) {
    for (const failure of failures) {
      const reason = failure.reason instanceof Error ? failure.reason.message : String(failure.reason);
      console.error(reason);
    }

    process.exitCode = 1;
  }

  const after = snapshotProviderModels();

  // Write PR summary when --summary <path> is passed
  const summaryIdx = process.argv.indexOf("--summary");
  if (summaryIdx !== -1 && process.argv[summaryIdx + 1]) {
    const summary = generateSummary(before, after);
    writeFileSync(process.argv[summaryIdx + 1], summary);
    console.log(`PR summary written to ${process.argv[summaryIdx + 1]}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
