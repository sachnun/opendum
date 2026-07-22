#!/usr/bin/env bun

import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildModelIndex } from "./model-registry.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const modelsDir = resolve(rootDir, "models");

const refreshScripts = [
  "antigravity-version.mjs",
  "antigravity-models.mjs",
  "codex.mjs",
  "command-code.mjs",
  "kilo-code.mjs",
  "kiro.mjs",
  "opencode.mjs",
  "openrouter.mjs",
  "nvidia.mjs",
  "cloudflare.mjs",
  "zenmux.mjs",
  "siliconflow.mjs",
];

const REFRESHED_PROVIDERS = ["antigravity", "codex", "command_code", "kilo_code", "kiro", "nvidia_nim", "opencode", "openrouter", "siliconflow", "workers_ai", "zenmux"];

// ---------------------------------------------------------------------------
// Run a child script
// ---------------------------------------------------------------------------

function runScript(scriptName) {
  const scriptPath = resolve(scriptDir, scriptName);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("bun", ["run", scriptPath], {
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
  const index = buildModelIndex(modelsDir);
  const snapshot = new Map();

  for (const provider of REFRESHED_PROVIDERS) {
    snapshot.set(provider, new Set());
  }

  for (const [modelId, entry] of Object.entries(index)) {
    const publicId = entry.id || modelId;
    const providers = entry.data.providers || [];
    for (const provider of providers) {
      if (snapshot.has(provider)) {
        snapshot.get(provider).add(publicId);
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

  const failures = [];

  for (const scriptName of refreshScripts) {
    try {
      await runScript(scriptName);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(reason);
      failures.push(scriptName);
    }
  }

  if (failures.length > 0) {
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
