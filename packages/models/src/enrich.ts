#!/usr/bin/env -S npx tsx

/**
 * Enrich the local model registry with external metadata.
 *
 * Fills `owner`, `modalities`, `parameter`, `limit`, and the per-provider
 * `contextWindow` / `maxOutputTokens` by matching local model ids against
 * OpenRouter, models.dev, LiteLLM, and NVIDIA NIM.
 *
 * Run after the provider refresh scripts so newly added models are covered:
 *   pnpm run models:refresh
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildModelIndex, writeModelJson } from "./registry.ts";
import type { ModelData } from "./types.ts";
import {
  buildModelPatch,
  fetchExternalRegistries,
  resolveModelMetadata,
  type ModelMetadataInput,
  type ModelMetadataPatch,
  type Registries,
} from "./metadata.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const modelsDir = resolve(scriptDir, "../data");

const MANAGED_PROVIDER_KEYS = ["contextWindow", "maxOutputTokens"] as const;


function modelCandidates(id: string, fileId: string, data: ModelData): Set<string> {
  const candidates = new Set<string>([id, fileId]);
  for (const alias of data.aliases ?? []) candidates.add(alias);
  for (const config of Object.values(data.providerConfig ?? {})) {
    const upstream = config.upstream;
    if (typeof upstream !== "string") continue;
    candidates.add(upstream);
    candidates.add(upstream.split("/").pop() ?? upstream);
  }
  return candidates;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function applyMetadata(data: ModelData, patch: ModelMetadataPatch): boolean {
  let changed = false;

  if (patch.owner) {
    const current = typeof data.owner === "string" ? data.owner.trim().toLowerCase() : null;
    if (current !== patch.owner) {
      data.owner = patch.owner;
      changed = true;
    }
  }

  if (patch.modalities && !sameValue(data.modalities, patch.modalities)) {
    data.modalities = patch.modalities;
    changed = true;
  }

  if (patch.parameter && !sameValue(data.parameter, patch.parameter)) {
    data.parameter = patch.parameter;
    changed = true;
  }

  if (Object.keys(patch.limits).length > 0 && !sameValue(data.limit, patch.limits)) {
    data.limit = patch.limits;
    changed = true;
  }

  for (const provider of data.providers ?? []) {
    const limits = patch.providerLimits[provider];
    if (!limits) continue;

    data.providerConfig ??= {};
    data.providerConfig[provider] ??= {};
    const config = data.providerConfig[provider]!;

    for (const key of MANAGED_PROVIDER_KEYS) {
      const next = limits[key];
      if (next === undefined) {
        if (config[key] !== undefined) {
          delete config[key];
          changed = true;
        }
        continue;
      }
      if (config[key] !== next) {
        config[key] = next;
        changed = true;
      }
    }

    if (Object.keys(config).length === 0) delete data.providerConfig[provider];
  }

  if (data.providerConfig && Object.keys(data.providerConfig).length === 0) {
    delete data.providerConfig;
  }

  return changed;
}

interface Stats {
  models: number;
  owner: number;
  limit: number;
  modalities: number;
  parameter: number;
  providerLimits: number;
  unmatched: string[];
  divergent: Array<{ id: string; min: number; max: number }>;
}

function reportRegistries(registries: Registries): void {
  const available = (Object.keys(registries) as Array<keyof Registries>)
    .filter((name) => registries[name] !== undefined);
  console.log(`[metadata] using registries: ${available.join(", ")}`);
}

function reportStats(stats: Stats, updatedCount: number, dryRun: boolean): void {
  console.log("");
  console.log(`[metadata] models: ${stats.models}`);
  console.log(
    `[metadata] owner: ${stats.owner}  limit: ${stats.limit}  modalities: ${stats.modalities}`
    + `  parameter: ${stats.parameter}  providerLimits: ${stats.providerLimits}`,
  );
  console.log(`[metadata] updated: ${updatedCount}${dryRun ? " (dry run)" : ""}`);

  if (stats.unmatched.length > 0) {
    console.log(`[metadata] unmatched (${stats.unmatched.length}): ${stats.unmatched.join(", ")}`);
  }

  if (stats.divergent.length > 0) {
    console.log(`[metadata] context differs across providers (${stats.divergent.length}), parent exposes the minimum:`);
    for (const item of stats.divergent) {
      console.log(`  ${item.id}: ${item.min}..${item.max}`);
    }
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");

  const registries = await fetchExternalRegistries({ logger: (message) => console.log(message) });
  if (Object.values(registries).every((registry) => registry === undefined)) {
    throw new Error("No external registry available, aborting metadata refresh");
  }
  reportRegistries(registries);

  const index = buildModelIndex(modelsDir);
  const stats: Stats = {
    models: 0,
    owner: 0,
    limit: 0,
    modalities: 0,
    parameter: 0,
    providerLimits: 0,
    unmatched: [],
    divergent: [],
  };
  const updated: string[] = [];

  for (const [fileId, entry] of Object.entries(index)) {
    const data = entry.data as ModelData;
    if (data.ignored) continue;

    const providers = data.providers ?? [];
    if (providers.length === 0) continue;

    stats.models += 1;
    const id = entry.id || fileId;
    const model: ModelMetadataInput = {
      id,
      candidates: modelCandidates(id, fileId, data),
      providers,
    };

    const upstreams: Record<string, string | undefined> = {};
    for (const provider of providers) {
      const upstream = data.providerConfig?.[provider]?.upstream;
      if (typeof upstream === "string") upstreams[provider] = upstream;
    }

    const resolved = resolveModelMetadata(model, registries);
    const patch = buildModelPatch(model, resolved, upstreams);

    const hasAnything = patch.owner
      || patch.modalities
      || patch.parameter
      || Object.keys(patch.providerLimits).length > 0;
    if (!hasAnything) {
      stats.unmatched.push(id);
      continue;
    }

    if (patch.owner) stats.owner += 1;
    if (patch.modalities) stats.modalities += 1;
    if (patch.parameter) stats.parameter += 1;
    if (Object.keys(patch.limits).length > 0) stats.limit += 1;
    if (Object.keys(patch.providerLimits).length > 0) stats.providerLimits += 1;

    if (patch.minimumProviderContext !== null && patch.minimumProviderContext !== patch.maximumProviderContext) {
      stats.divergent.push({ id, min: patch.minimumProviderContext, max: patch.maximumProviderContext ?? patch.minimumProviderContext });
    }

    if (applyMetadata(data, patch)) {
      updated.push(id);
      if (!dryRun) writeModelJson(entry.path, data);
      if (verbose) {
        console.log(`[metadata] ${id} owner=${patch.owner} limit=${JSON.stringify(patch.limits)}`);
      }
    }
  }

  reportStats(stats, updated.length, dryRun);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
