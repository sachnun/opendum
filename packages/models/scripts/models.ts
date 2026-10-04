#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildModelIndex, pruneDeadModelEntries } from "#models/registry.ts";
import { discoverSources, orderSources } from "./runner.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const modelsDir = resolve(scriptDir, "../data");

function refreshedProviders(): string[] {
  const providers = new Set<string>();
  for (const entry of Object.values(buildModelIndex(modelsDir))) {
    for (const provider of entry.data.providers ?? []) providers.add(provider);
  }
  return [...providers].sort();
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
      .map((entry) => `+ ${entry.model} (${entry.provider})`);
    sections.push(`Added ${added.length} model${added.length === 1 ? "" : "s"}\n${lines.join("\n")}`);
  }

  if (removed.length) {
    const lines = removed
      .sort((a, b) => a.model.localeCompare(b.model))
      .map((entry) => `- ${entry.model} (${entry.provider})`);
    sections.push(`Removed ${removed.length} model${removed.length === 1 ? "" : "s"}\n${lines.join("\n")}`);
  }

  return sections.length > 0 ? `${sections.join("\n\n")}\n` : "";
}

async function main(): Promise<void> {
  const providers = refreshedProviders();
  const before = snapshotProviderModels(providers);
  const failures: string[] = [];

  for (const source of orderSources(await discoverSources())) {
    try {
      await source.run();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(reason);
      failures.push(source.name);
    }
  }

  if (failures.length > 0) {
    process.exitCode = 1;
  }

  const pruned = pruneDeadModelEntries(modelsDir);
  if (pruned.length > 0) {
    console.log(`[models] pruned ${pruned.length} dead entries: ${pruned.join(", ")}`);
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
