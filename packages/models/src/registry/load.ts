import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { ModelEntry, ModelInfo, ProviderModelConfig } from "#models/registry/runtime.ts";

function resolveGeneratedDir(dir: string): string {
  const configured = process.env.MODELS_GENERATED_DIR?.trim();
  if (configured) return configured;
  return join(dirname(dir), "generated");
}

function readModelEntries(dir: string, required: boolean): ModelEntry[] {
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    if (required) throw new Error(`models directory not found: ${dir}`);
    return [];
  }
  if (!stat.isDirectory()) {
    if (required) throw new Error(`models path is not a directory: ${dir}`);
    return [];
  }

  const entries: ModelEntry[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const fullPath = join(current, name);
      const entryStat = statSync(fullPath);
      if (entryStat.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!name.endsWith(".json")) continue;
      const parsed = JSON.parse(readFileSync(fullPath, "utf8")) as ModelInfo;
      const parent = dirname(fullPath);
      entries.push({
        fileId: basename(name, ".json"),
        owner: parent === dir ? "" : basename(parent),
        info: parsed,
      });
    }
  };
  walk(dir);
  return entries;
}

function mergeGeneratedInfo(authored: ModelEntry, generated: ModelEntry): void {
  if (!authored.info.id) authored.info.id = generated.info.id;
  if ((authored.info.providers ?? []).length === 0) authored.info.providers = generated.info.providers;
  if ((generated.info.aliases ?? []).length > 0) {
    authored.info.aliases = [...(authored.info.aliases ?? []), ...(generated.info.aliases ?? [])];
  }
  if (authored.info.reasoning === undefined) authored.info.reasoning = generated.info.reasoning;
  if (!authored.info.reasoning_effort) authored.info.reasoning_effort = generated.info.reasoning_effort;
  if (authored.info.modalities == null) authored.info.modalities = generated.info.modalities;
  if (authored.info.limit == null) authored.info.limit = generated.info.limit;
  if (authored.info.cost == null) authored.info.cost = generated.info.cost;
  if (authored.info.scores == null) authored.info.scores = generated.info.scores;
  const generatedConfig = generated.info.providerConfig ?? {};
  if (Object.keys(generatedConfig).length > 0) {
    authored.info.providerConfig = authored.info.providerConfig ?? {};
    for (const [provider, config] of Object.entries(generatedConfig)) {
      const existing = authored.info.providerConfig[provider];
      authored.info.providerConfig[provider] = existing
        ? mergeProviderConfig(config, existing)
        : config;
    }
  }
}

const KNOWN_PROVIDER_CONFIG_KEYS = new Set([
  "upstream",
  "contextWindow",
  "maxOutputTokens",
  "minTier",
  "allowedTiers",
  "authless",
  "free",
  "aliases",
  "custom",
]);

function mergeProviderConfig(
  generated: ProviderModelConfig,
  authored: ProviderModelConfig
): ProviderModelConfig {
  const merged: ProviderModelConfig = { ...generated };
  if (authored.upstream) merged.upstream = authored.upstream;
  if (authored.contextWindow) merged.contextWindow = authored.contextWindow;
  if (authored.maxOutputTokens) merged.maxOutputTokens = authored.maxOutputTokens;
  if (authored.minTier) merged.minTier = authored.minTier;
  if ((authored.allowedTiers ?? []).length > 0) merged.allowedTiers = authored.allowedTiers;
  if (authored.authless) merged.authless = true;
  if (authored.free) merged.free = true;
  if ((authored.aliases ?? []).length > 0) merged.aliases = authored.aliases;

  const custom: Record<string, unknown> = { ...(merged.custom ?? {}) };
  for (const [key, value] of Object.entries(authored)) {
    if (KNOWN_PROVIDER_CONFIG_KEYS.has(key)) continue;
    delete merged[key];
    custom[key] = value;
  }
  if (authored.custom && Object.keys(authored.custom).length > 0) {
    for (const [key, value] of Object.entries(authored.custom)) custom[key] = value;
  }
  if (Object.keys(custom).length > 0) merged.custom = custom;
  return merged;
}

function collectModelEntries(authoredDir: string, generatedDir: string): ModelEntry[] {
  const authored = readModelEntries(authoredDir, true);
  const generated = readModelEntries(generatedDir, false);

  const byFileId = new Map<string, ModelEntry>();
  const order: string[] = [];
  for (const entry of authored) {
    if (!byFileId.has(entry.fileId)) order.push(entry.fileId);
    byFileId.set(entry.fileId, { ...entry, info: { ...entry.info } });
  }
  for (const entry of generated) {
    const existing = byFileId.get(entry.fileId);
    if (existing) {
      mergeGeneratedInfo(existing, entry);
      continue;
    }
    order.push(entry.fileId);
    byFileId.set(entry.fileId, { ...entry, info: { ...entry.info } });
  }
  return order.map((fileId) => byFileId.get(fileId) as ModelEntry);
}

export function loadModelEntries(dir: string): ModelEntry[] {
  return collectModelEntries(dir, resolveGeneratedDir(dir));
}
