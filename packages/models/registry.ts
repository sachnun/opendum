import { Effect } from "effect";

import { familyOf } from "./model/families.ts";
import { ModelParseFailure, ModelReadFailure, ModelsDirectoryFailure, asError } from "./errors.ts";
import { exists, isDirectory, listJson, readText } from "./fs.ts";
import { basename, dirname, join } from "./paths.ts";
import { decodeSync } from "./schema.ts";
import { Catalog } from "./catalog.ts";
import { Aliases } from "./aliases.ts";
import { View } from "./view.ts";
import { Suggester } from "./suggester.ts";
import { Serializer } from "./serializer.ts";
import { Policy } from "./policy.ts";

export { scoreFor } from "./suggester.ts";
export { nvidiaAlias } from "./aliases.ts";

export type ModelModalities = {
  input?: string[];
  output?: string[];
};

export type ModelLimit = {
  context?: number;
  output?: number;
};

export type ModelCost = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export type ProviderAccessRule = {
  minTier?: string;
  allowedTiers?: string[];
};

export type ProviderModelConfig = {
  upstream?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  minTier?: string;
  allowedTiers?: string[];
  authless?: boolean;
  free?: boolean;
  aliases?: string[];
  custom?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ModelScores = {
  artificialAnalysis?: {
    index?: number;
    estimated?: boolean;
  };
};

export type ModelInfo = {
  id?: string;
  providers: string[];
  aliases?: string[];
  description?: string;
  ignored?: boolean;
  reasoning?: boolean | null;
  reasoning_effort?: string[] | null;
  family?: string;
  owner?: string;
  modalities?: ModelModalities | null;
  limit?: ModelLimit | null;
  cost?: ModelCost | null;
  scores?: ModelScores | null;
  providerConfig?: Record<string, ProviderModelConfig>;
};

export type ModelEntry = {
  fileId: string;
  owner: string;
  info: ModelInfo;
};

export function providerAlias(provider: string): string {
  return provider.trim().toLowerCase();
}

function generatedDir(dir: string): string {
  return join(dirname(dir), "generated");
}

function readEntries(dir: string, required: boolean): ModelEntry[] {
  if (!exists(dir)) {
    if (required) {
      throw new ModelsDirectoryFailure({
        message: `models directory not found: ${dir}`,
        path: dir,
        cause: undefined,
      });
    }
    return [];
  }
  if (!isDirectory(dir)) {
    if (required) {
      throw new ModelsDirectoryFailure({ message: `models path is not a directory: ${dir}`, path: dir });
    }
    return [];
  }

  const entries: ModelEntry[] = [];
  for (const relativePath of listJson(dir)) {
    if (!relativePath.endsWith(".json")) continue;
    const fullPath = join(dir, relativePath);
    let parsed: ModelInfo;
    try {
      parsed = decodeSync(readText(fullPath), fullPath) as ModelInfo;
    } catch (cause) {
      if (cause instanceof ModelParseFailure) throw cause;
      throw new ModelParseFailure({ message: `invalid model JSON: ${fullPath}`, path: fullPath, cause });
    }
    const segments = relativePath.split("/");
    entries.push({
      fileId: basename(relativePath, ".json"),
      owner: segments.length > 1 ? (segments[0] ?? "") : "",
      info: parsed,
    });
  }
  return entries;
}

function mergeGenerated(authored: ModelEntry, generated: ModelEntry): void {
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
        ? mergeConfig(config, existing)
        : config;
    }
  }
}

const CONFIG_KEYS = new Set([
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

function mergeConfig(
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

  const custom: Record<string, unknown> = { ...merged.custom };
  for (const [key, value] of Object.entries(authored)) {
    if (CONFIG_KEYS.has(key)) continue;
    delete merged[key];
    custom[key] = value;
  }
  if (authored.custom && Object.keys(authored.custom).length > 0) {
    for (const [key, value] of Object.entries(authored.custom)) custom[key] = value;
  }
  if (Object.keys(custom).length > 0) merged.custom = custom;
  return merged;
}

function collectEntries(authoredDir: string, generatedDir: string): ModelEntry[] {
  const authored = readEntries(authoredDir, true);
  const generated = readEntries(generatedDir, false);

  const byFile = new Map<string, ModelEntry>();
  const order: string[] = [];
  for (const entry of authored) {
    if (!byFile.has(entry.fileId)) order.push(entry.fileId);
    byFile.set(entry.fileId, { ...entry, info: { ...entry.info } });
  }
  for (const entry of generated) {
    const existing = byFile.get(entry.fileId);
    if (existing) {
      mergeGenerated(existing, entry);
      continue;
    }
    order.push(entry.fileId);
    byFile.set(entry.fileId, { ...entry, info: { ...entry.info } });
  }
  return order.map((fileId) => byFile.get(fileId) as ModelEntry);
}

export function loadEntries(dir: string): ModelEntry[] {
  return collectEntries(dir, generatedDir(dir));
}

export function loadSafe(
  dir: string
): Effect.Effect<ModelEntry[], ModelsDirectoryFailure | ModelReadFailure | ModelParseFailure> {
  return Effect.try({
    try: () => loadEntries(dir),
    catch: (cause) => cause,
  }).pipe(
    Effect.mapError((cause) => {
      if (
        cause instanceof ModelsDirectoryFailure ||
        cause instanceof ModelReadFailure ||
        cause instanceof ModelParseFailure
      ) {
        return cause;
      }
      return new ModelReadFailure({ message: asError(cause).message, path: dir, cause });
    })
  );
}

export function tryLoad(
  dir: string,
  options: { familyFromFolder?: boolean } = {}
): Effect.Effect<Registry, ModelsDirectoryFailure | ModelReadFailure | ModelParseFailure> {
  return Effect.map(loadSafe(dir), (entries) => Registry.fromEntries(entries, options));
}

export type FlagshipFamily = {
  family: string;
  folder: string;
  score: number;
};

export function flagshipRanking(entries: ModelEntry[]): FlagshipFamily[] {
  const best = new Map<string, FlagshipFamily>();
  for (const entry of entries) {
    const index = entry.info.scores?.artificialAnalysis?.index;
    if (typeof index !== "number" || !Number.isFinite(index)) continue;
    const family = entry.info.family || familyOf(entry.owner);
    if (!family) continue;
    const current = best.get(family);
    if (!current || index > current.score) best.set(family, { family, folder: entry.owner || "", score: index });
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.family.localeCompare(b.family));
}

export class Registry {
  private readonly catalog: Catalog;
  private readonly aliases: Aliases;
  private readonly providerView: View;
  private readonly suggester: Suggester;
  private readonly serializer: Serializer;
  private readonly access: Policy;

  private constructor(entries: ModelEntry[], options: { familyFromFolder?: boolean } = {}) {
    this.catalog = Catalog.fromEntries(entries, options);
    this.aliases = Aliases.build({
      canonicalIds: () => this.catalog.canonicalIds(),
      info: (model) => this.catalog.info(model),
    });
    this.providerView = new View({
      canonical: (model) => this.aliases.resolve(model),
      info: (model) => this.catalog.info(model),
      entries: () => this.catalog.entries(),
    });
    this.suggester = Suggester.fromModels(
      this.catalog.all().map((value) => ({ value, providers: (this.catalog.info(value) as ModelInfo).providers }))
    );
    this.serializer = new Serializer({
      models: () => this.allModels(),
      info: (model) => this.modelInfo(model),
    });
    this.access = new Policy({
      info: (model) => this.modelInfo(model),
      entries: () => this.catalog.entries(),
    });
  }

  static load(dir: string, options: { familyFromFolder?: boolean } = {}): Registry {
    return new Registry(loadEntries(dir), options);
  }

  static fromEntries(entries: ModelEntry[], options: { familyFromFolder?: boolean } = {}): Registry {
    return new Registry(entries, options);
  }

  resolveAlias(model: string): string {
    return this.aliases.resolve(model);
  }

  lookupKeys(model: string): string[] {
    return this.aliases.keys(model);
  }

  providers(model: string): string[] {
    return this.providerView.providers(model);
  }

  isSupported(model: string): boolean {
    return this.providers(model).length > 0;
  }

  supportsProvider(model: string, provider: string): boolean {
    return this.providers(model).includes(provider);
  }

  upstream(model: string, provider: string): string {
    return this.providerView.upstream(model, provider);
  }

  rule(model: string, provider: string): ProviderAccessRule | null {
    return this.access.rule(model, provider);
  }

  config(model: string, provider: string): ProviderModelConfig | null {
    return this.access.config(model, provider);
  }

  isAuthless(model: string, provider: string): boolean {
    return this.access.isAuthless(model, provider);
  }

  isFree(model: string, provider: string): boolean {
    return this.access.isFree(model, provider);
  }

  authlessModels(): Map<string, string[]> {
    return this.access.authlessModels();
  }

  modelMap(provider: string): Map<string, string> {
    return this.providerView.modelMap(provider);
  }

  modelSet(provider: string): Set<string> {
    return this.providerView.modelSet(provider);
  }

  allModels(): string[] {
    return this.catalog.all();
  }

  models(provider: string): string[] {
    return this.providerView.models(provider);
  }

  suggestedModels(
    model: string,
    provider: string | null,
    candidates: string[] | null,
    limit: number
  ): string[] {
    return this.suggester.suggest(model, provider, candidates, limit);
  }

  modelInfo(model: string): ModelInfo | null {
    return this.catalog.info(this.resolveAlias(model));
  }

  modelFamily(model: string): string {
    return this.modelInfo(model)?.family ?? "";
  }

  modelCost(model: string): ModelCost | null {
    return this.modelInfo(model)?.cost ?? null;
  }

  entries(): Record<string, ModelInfo> {
    const out: Record<string, ModelInfo> = {};
    for (const [modelId, info] of this.catalog.entries()) out[modelId] = info;
    return out;
  }

  ignoredModels(): string[] {
    return this.catalog.ignoredModels();
  }

  families(): string[] {
    return this.catalog.families();
  }

  openAiModels(): Array<Record<string, unknown>> {
    return this.serializer.format();
  }

  isReasoningModel(model: string): boolean {
    return this.serializer.isReasoning(model);
  }

  isVisionModel(model: string): boolean {
    return this.serializer.isVision(model);
  }
}

