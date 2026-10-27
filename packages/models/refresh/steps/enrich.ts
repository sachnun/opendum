import { raise } from "@opendum/models/refresh/core/raise";
import { folderOf } from "@opendum/models/model/families";
import { buildIndex, persist, moveFiles, generatedDir } from "@opendum/models/model-store";
import { applyMerge, planCanonicalization } from "@opendum/models/model/canonicalize";
import { modelProbes } from "@opendum/models/model/probes";
import { exists, remove, rename } from "@opendum/models/fs";
import { basename, dirname, join } from "@opendum/models/paths";
import { flags, dataDir, runScript } from "@opendum/models/refresh/core/env";
import type { ModelData } from "@opendum/models/types";
import {
  modelPatch,
  externalRegistries,
  modelMetadata,
  type ModelMetadataInput,
  type ModelMetadataPatch,
  type Registries,
} from "@opendum/models/sync/metadata";

const modelsDir = dataDir();

const MANAGED_PROVIDER_KEYS = ["contextWindow", "maxOutputTokens"] as const;

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function applyMetadata(data: ModelData, patch: ModelMetadataPatch): boolean {
  let changed = false;

  if (patch.reasoning !== null && data.reasoning !== patch.reasoning) {
    data.reasoning = patch.reasoning;
    changed = true;
  }

  if (patch.reasoningEffort && !sameValue(data.reasoning_effort, patch.reasoningEffort)) {
    data.reasoning_effort = patch.reasoningEffort;
    changed = true;
  }

  if (patch.modalities && !sameValue(data.modalities, patch.modalities)) {
    data.modalities = patch.modalities;
    changed = true;
  }

  if (Object.keys(patch.limits).length > 0 && !sameValue(data.limit, patch.limits)) {
    data.limit = patch.limits;
    changed = true;
  }

  if (patch.cost && !sameValue(data.cost, patch.cost)) {
    data.cost = patch.cost;
    changed = true;
  }

  for (const provider of data.providers ?? []) {
    const limits = patch.providerLimits[provider];
    if (!limits) continue;

    data.providerConfig ??= {};
    data.providerConfig[provider] ??= {};
    const config = data.providerConfig[provider];

    for (const key of MANAGED_PROVIDER_KEYS) {
      const next = limits[key];
      if (next === undefined) {
        if (config[key] !== undefined) {
          Reflect.deleteProperty(config, key);
          changed = true;
        }
        continue;
      }
      if (config[key] !== next) {
        config[key] = next;
        changed = true;
      }
    }

    if (Object.keys(config).length === 0 && data.providerConfig) {
      Reflect.deleteProperty(data.providerConfig, provider);
    }
  }

  if (data.providerConfig && Object.keys(data.providerConfig).length === 0) {
    delete data.providerConfig;
  }

  return changed;
}

interface Stats {
  models: number;
  reasoning: number;
  reasoningEffort: number;
  limit: number;
  modalities: number;
  cost: number;
  providerLimits: number;
  unmatched: string[];
  divergent: Array<{ id: string; min: number; max: number }>;
  canonicalized: Array<{ from: string; to: string; tier: string }>;
  ambiguous: string[];
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
    `[metadata] reasoning: ${stats.reasoning}  reasoningEffort: ${stats.reasoningEffort}  limit: ${stats.limit}`
    + `  modalities: ${stats.modalities}  cost: ${stats.cost}  providerLimits: ${stats.providerLimits}`,
  );
  console.log(`[metadata] updated: ${updatedCount}${dryRun ? " (dry run)" : ""}`);
  console.log(`[metadata] canonicalized: ${stats.canonicalized.length}${dryRun ? " (dry run)" : ""}`);

  for (const item of stats.canonicalized) {
    console.log(`  ${item.from} -> ${item.to} [${item.tier}]`);
  }

  if (stats.ambiguous.length > 0) {
    console.log(`[metadata] unresolved canonical ids (${stats.ambiguous.length}): ${stats.ambiguous.join(", ")}`);
  }

  if (stats.unmatched.length > 0) {
    console.log(`[metadata] unmatched (${stats.unmatched.length}): ${stats.unmatched.join(", ")}`);
  }

  if (stats.divergent.length > 0) {
    console.log(`[metadata] context differs across providers (${stats.divergent.length}), parent exposes the maximum:`);
    for (const item of stats.divergent) {
      console.log(`  ${item.id}: ${item.min}..${item.max}`);
    }
  }
}

async function canonicalizeIds(
  canonical: Awaited<ReturnType<typeof externalRegistries>>["canonical"],
  stats: Stats,
  dryRun: boolean,
): Promise<void> {
  const index = buildIndex(modelsDir);
  const models = Object.values(index).map((entry) => ({
    id: entry.id,
    relativeId: entry.relativeId,
    fileId: entry.fileId,
    path: entry.path,
    data: entry.data as ModelData,
  }));
  const byModelId = new Map(models.map((model) => [model.id, model]));
  const plan = planCanonicalization(models, canonical);

  const targets = new Map<string, { relativeId: string; data: ModelData }>();
  for (const action of plan.actions) {
    if (action.kind !== "rename") continue;
    const aliases = new Set(action.data.aliases ?? []);
    aliases.add(action.from);
    if (action.fileId !== action.from) aliases.add(action.fileId);
    aliases.delete(action.to);
    action.data.id = action.to;
    action.data.aliases = [...aliases].sort();
    targets.set(action.to, { relativeId: action.relativeId, data: action.data });
    stats.canonicalized.push({ from: action.from, to: action.to, tier: action.tier });
  }

  for (const action of plan.actions) {
    if (action.kind !== "merge") continue;
    const target = targets.get(action.to) ?? byModelId.get(action.to);
    if (!target) {
      stats.ambiguous.push(`${action.from} (missing merge target ${action.to})`);
      continue;
    }
    applyMerge(target.data as ModelData, action);
    stats.canonicalized.push({ from: action.from, to: action.to, tier: `merge:${action.tier}` });
    if (dryRun) continue;
    await persist({ modelsDir, relativeId: target.relativeId }, target.data as ModelData);
    await remove(action.path);
  }

  stats.ambiguous.push(...plan.unresolved);
  if (plan.conflicts.length > 0) {
    console.log(
      `[metadata] canonical merges refused to protect authored config (${plan.conflicts.length}): ${plan.conflicts.join(", ")}`,
    );
  }

  if (dryRun) return;
  const dir = generatedDir(modelsDir);
  for (const target of targets.values()) {
    await persist({ modelsDir, relativeId: target.relativeId }, target.data);
  }
  for (const [nextFileId, target] of targets) {
    await moveFiles({ modelsDir, generatedDir: dir, relativeId: target.relativeId }, nextFileId);
  }
}

async function relocateRoots(dryRun: boolean): Promise<string[]> {
  const index = buildIndex(modelsDir);
  const moved: string[] = [];
  for (const [fileId, entry] of Object.entries(index)) {
    if (dirname(entry.path) !== modelsDir) continue;
    const id = entry.id || fileId;
    const folder = folderOf(id);
    if (!folder) continue;
    const target = join(modelsDir, folder, basename(entry.path));
    if (exists(target)) continue;
    moved.push(`${id} -> ${folder}/`);
    if (!dryRun) await rename(entry.path, target);
  }
  return moved;
}

async function main(): Promise<void> {
  const { dryRun, verbose } = flags();

  const catalogs = await externalRegistries({ logger: (message) => console.log(message) });
  const registries = catalogs.registries;
  if (Object.values(registries).every((registry) => registry === undefined)) {
    raise(new Error("No external registry available, aborting metadata refresh"));
  }
  reportRegistries(registries);

  const stats: Stats = {
    models: 0,
    reasoning: 0,
    reasoningEffort: 0,
    limit: 0,
    modalities: 0,
    cost: 0,
    providerLimits: 0,
    unmatched: [],
    divergent: [],
    canonicalized: [],
    ambiguous: [],
  };
  const updated: string[] = [];

  await canonicalizeIds(catalogs.canonical, stats, dryRun);

  const index = buildIndex(modelsDir);

  for (const [fileId, entry] of Object.entries(index)) {
    const data = entry.data as ModelData;
    if (data.ignored) continue;

    const providers = data.providers ?? [];
    if (providers.length === 0) continue;

    stats.models += 1;
    const id = entry.id || fileId;
    const model: ModelMetadataInput = {
      id,
      candidates: modelProbes({ id, fileId, data }),
      providers,
    };

    const resolved = modelMetadata(model, registries);
    const patch = modelPatch(model, resolved);

    const hasAnything = patch.reasoning !== null
      || patch.reasoningEffort
      || patch.modalities
      || patch.cost
      || Object.keys(patch.providerLimits).length > 0;
    if (!hasAnything) {
      stats.unmatched.push(id);
      continue;
    }

    if (patch.reasoning !== null) stats.reasoning += 1;
    if (patch.reasoningEffort) stats.reasoningEffort += 1;
    if (patch.modalities) stats.modalities += 1;
    if (patch.cost) stats.cost += 1;
    if (Object.keys(patch.limits).length > 0) stats.limit += 1;
    if (Object.keys(patch.providerLimits).length > 0) stats.providerLimits += 1;

    if (patch.minimumProviderContext !== null && patch.minimumProviderContext !== patch.maximumProviderContext) {
      stats.divergent.push({ id, min: patch.minimumProviderContext, max: patch.maximumProviderContext ?? patch.minimumProviderContext });
    }

    if (applyMetadata(data, patch)) {
      updated.push(id);
      if (!dryRun) await persist(entry, data);
      if (verbose) {
        console.log(`[metadata] ${id} reasoning=${patch.reasoning} limit=${JSON.stringify(patch.limits)}`);
      }
    }
  }

  reportStats(stats, updated.length, dryRun);

  const moved = await relocateRoots(dryRun);
  if (moved.length > 0) {
    console.log(`[metadata] relocated ${moved.length} model files into family folders${dryRun ? " (dry run)" : ""}:`);
    for (const item of moved) console.log(`  ${item}`);
  }
}

runScript(main);
