#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildModelIndex } from "../src/registry.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const modelsDir = resolve(scriptDir, "../data");

const refreshScripts = [
  "antigravity-version.ts",
  "antigravity-models.ts",
  "cline.ts",
  "codex.ts",
  "kilo-code.ts",
  "kiro.ts",
  "opencode.ts",
  "openrouter.ts",
  "perch.ts",
  "qoder.ts",
  "nvidia.ts",
  "cloudflare.ts",
  "zenmux.ts",
  "harbor.ts",
  "hyper.ts",
  "workbuddy.ts",
  "../src/enrich.ts",
];

const REFRESHED_PROVIDERS = ["antigravity", "cline", "codex", "harbor", "hyper", "kilo_code", "kiro", "nvidia_nim", "opencode", "openrouter", "perch", "qoder", "workers_ai", "workbuddy", "zenmux"];

// ---------------------------------------------------------------------------
// Run a child script
// ---------------------------------------------------------------------------

function runScript(scriptName: string): Promise<void> {
  const scriptPath = resolve(scriptDir, scriptName);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["--import", "tsx", scriptPath], {
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

async function main(): Promise<void> {
  const before = snapshotProviderModels();

  const failures: string[] = [];

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
