#!/usr/bin/env node

import { readdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildModelIndex } from "#models/registry.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const modelsDir = resolve(scriptDir, "../data");
const SELF = basename(fileURLToPath(import.meta.url));

const TAIL_SCRIPTS = ["aa.ts", "enrich.ts"];

function refreshScripts(): string[] {
  return readdirSync(scriptDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && entry.name !== SELF)
    .map((entry) => entry.name)
    .sort((left, right) => {
      const rank = Number(TAIL_SCRIPTS.includes(left)) - Number(TAIL_SCRIPTS.includes(right));
      return rank !== 0 ? rank : left.localeCompare(right);
    });
}

function refreshedProviders(): string[] {
  const providers = new Set<string>();
  for (const entry of Object.values(buildModelIndex(modelsDir))) {
    for (const provider of entry.data.providers ?? []) providers.add(provider);
  }
  return [...providers].sort();
}

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

function snapshotProviderModels(before: string[]) {
  const index = buildModelIndex(modelsDir);
  const snapshot = new Map<string, Set<string>>();

  for (const provider of before) {
    snapshot.set(provider, new Set());
  }

  for (const [modelId, entry] of Object.entries(index)) {
    const publicId = entry.id || modelId;
    for (const provider of entry.data.providers ?? []) {
      snapshot.get(provider)?.add(publicId);
    }
  }

  return snapshot;
}

function generateSummary(before: Map<string, Set<string>>, after: Map<string, Set<string>>): string {
  const added: Array<{ model: string; provider: string }> = [];
  const removed: Array<{ model: string; provider: string }> = [];

  for (const provider of new Set([...before.keys(), ...after.keys()])) {
    const oldKeys = before.get(provider) ?? new Set<string>();
    const newKeys = after.get(provider) ?? new Set<string>();

    for (const key of newKeys) {
      if (!oldKeys.has(key)) added.push({ model: key, provider });
    }
    for (const key of oldKeys) {
      if (!newKeys.has(key)) removed.push({ model: key, provider });
    }
  }

  const sections: string[] = [];

  if (added.length) {
    const lines = added
      .sort((a, b) => a.model.localeCompare(b.model))
      .map((e) => `+ ${e.model} (${e.provider})`);
    sections.push(`Added ${added.length} model${added.length === 1 ? "" : "s"}\n${lines.join("\n")}`);
  }

  if (removed.length) {
    const lines = removed
      .sort((a, b) => a.model.localeCompare(b.model))
      .map((e) => `- ${e.model} (${e.provider})`);
    sections.push(`Removed ${removed.length} model${removed.length === 1 ? "" : "s"}\n${lines.join("\n")}`);
  }

  return sections.length > 0 ? sections.join("\n\n") + "\n" : "";
}

async function main(): Promise<void> {
  const providers = refreshedProviders();
  const before = snapshotProviderModels(providers);

  const failures: string[] = [];

  for (const scriptName of refreshScripts()) {
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

  const after = snapshotProviderModels(providers);

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
