import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Effect } from "effect";

import { inferFamilyFromFolder } from "./model/families.ts";
import { ModelParseFailure, ModelReadFailure, ModelsDirectoryFailure, asError } from "./errors.ts";
import { compactStrings, uniqueSorted, uniqueSortedStable } from "./collections.ts";
import { ModelSuggester } from "./suggester.ts";
import { OpenAIModelSerializer } from "./serializer.ts";
import { AccessPolicy } from "./access-policy.ts";

export { suggestionScoreFor } from "./suggester.ts";

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

export function normalizeProviderAlias(provider: string): string {
  return provider.trim().toLowerCase();
}

export function legacyNvidiaAlias(upstream: string): string {
  const stripped = upstream.startsWith("library/") ? upstream.slice("library/".length) : upstream;
  const replaced = stripped.replace(/[:/]/g, "-").replace(/[^a-zA-Z0-9._-]/g, "-");
  return replaced.replace(/-{2,}/g, "-");
}

function resolveGeneratedDir(dir: string): string {
  const configured = process.env.MODELS_GENERATED_DIR?.trim();
  if (configured) return configured;
  return join(dirname(dir), "generated");
}

function readModelEntries(dir: string, required: boolean): ModelEntry[] {
  let stat;
  try {
    stat = statSync(dir);
  } catch (cause) {
    if (required) throw new ModelsDirectoryFailure({ message: `models directory not found: ${dir}`, path: dir, cause });
    return [];
  }
  if (!stat.isDirectory()) {
    if (required) throw new ModelsDirectoryFailure({ message: `models path is not a directory: ${dir}`, path: dir });
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
      let parsed: ModelInfo;
      try {
        parsed = JSON.parse(readFileSync(fullPath, "utf8")) as ModelInfo;
      } catch (cause) {
        throw new ModelParseFailure({ message: `invalid model JSON: ${fullPath}`, path: fullPath, cause });
      }
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

  // Provider flags outside the known fields (for example opencode's
  // responses_api) are preserved under `custom`, matching the Go registry.
  const custom: Record<string, unknown> = { ...merged.custom };
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

/**
 * Effect wrapper around {@link loadModelEntries} exposing directory, read, and
 * parse problems on the typed failure channel.
 */
export function tryLoadModelEntries(
  dir: string
): Effect.Effect<ModelEntry[], ModelsDirectoryFailure | ModelReadFailure | ModelParseFailure> {
  return Effect.try({
    try: () => loadModelEntries(dir),
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

export type FlagshipFamily = {
  family: string;
  folder: string;
  score: number;
};

export function flagshipFamilyRanking(entries: ModelEntry[]): FlagshipFamily[] {
  const best = new Map<string, FlagshipFamily>();
  for (const entry of entries) {
    const index = entry.info.scores?.artificialAnalysis?.index;
    if (typeof index !== "number" || !Number.isFinite(index)) continue;
    const family = entry.info.family || inferFamilyFromFolder(entry.owner);
    if (!family) continue;
    const current = best.get(family);
    if (!current || index > current.score) best.set(family, { family, folder: entry.owner || "", score: index });
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.family.localeCompare(b.family));
}

export class Registry {
  private readonly models = new Map<string, ModelInfo>();
  private readonly effective = new Map<string, ModelInfo>();
  private readonly ignored = new Set<string>();
  private readonly aliasToCanonical = new Map<string, string>();
  private readonly foldedAliasToCanonical = new Map<string, string>();
  private readonly canonicalToAliases = new Map<string, string[]>();
  private readonly providerModelMapCache = new Map<string, Map<string, string>>();
  private readonly providerModelSetCache = new Map<string, Set<string>>();
  private readonly suggester: ModelSuggester;
  private readonly serializer: OpenAIModelSerializer;
  private readonly access: AccessPolicy;

  private constructor(entries: ModelEntry[], options: { familyFromFolder?: boolean } = {}) {
    for (const entry of entries) {
      const info: ModelInfo = { ...entry.info };
      info.id = (info.id ?? "").trim();
      info.providers = compactStrings(info.providers);
      info.aliases = compactStrings(info.aliases);
      if (entry.owner) info.owner = entry.owner;
      if (options.familyFromFolder && !info.family && entry.owner) {
        info.family = inferFamilyFromFolder(entry.owner) ?? entry.owner;
      }
      const modelId = info.id ? info.id : entry.fileId;
      this.mergeModelInfo(modelId, entry.fileId, info);
      if (info.ignored) this.ignored.add(modelId);
    }
    this.buildAliases();
    this.suggester = ModelSuggester.fromModels(
      this.allModels().map((value) => ({ value, providers: (this.effective.get(value) as ModelInfo).providers }))
    );
    this.serializer = new OpenAIModelSerializer({
      models: () => this.allModels(),
      info: (model) => this.modelInfo(model),
    });
    this.access = new AccessPolicy({
      info: (model) => this.modelInfo(model),
      entries: () => this.effective,
    });
  }

  static load(dir: string, options: { familyFromFolder?: boolean } = {}): Registry {
    return new Registry(loadModelEntries(dir), options);
  }

  static fromEntries(entries: ModelEntry[], options: { familyFromFolder?: boolean } = {}): Registry {
    return new Registry(entries, options);
  }

  private mergeModelInfo(modelId: string, fileId: string, info: ModelInfo): void {
    if (!info.id) info.id = modelId;
    const aliases = [...(info.aliases ?? [])];
    if (fileId !== modelId) aliases.push(fileId);

    const existing = this.models.get(modelId);
    if (!existing) {
      const stored = { ...info, aliases: uniqueSorted(aliases) };
      this.models.set(modelId, stored);
      if (!stored.ignored) this.effective.set(modelId, stored);
      return;
    }

    const merged: ModelInfo = { ...existing };
    merged.id = modelId;
    merged.providers = uniqueSorted([...(existing.providers ?? []), ...(info.providers ?? [])]);
    merged.aliases = uniqueSorted([...(existing.aliases ?? []), ...aliases]);
    if (!merged.description) merged.description = info.description;
    if (!merged.family) merged.family = info.family;
    merged.ignored = Boolean(existing.ignored && info.ignored);
    if (merged.reasoning == null) merged.reasoning = info.reasoning;
    if (merged.reasoning_effort == null) merged.reasoning_effort = info.reasoning_effort;
    if (merged.modalities == null) merged.modalities = info.modalities;
    if (info.providerConfig && Object.keys(info.providerConfig).length > 0) {
      merged.providerConfig = { ...merged.providerConfig, ...info.providerConfig };
    }

    this.models.set(modelId, merged);
    if (!merged.ignored) this.effective.set(modelId, merged);
    else this.effective.delete(modelId);
  }

  private assignAlias(alias: string, canonical: string): void {
    const trimmed = alias.trim();
    if (!trimmed) return;
    if (this.effective.has(trimmed)) return;
    if (this.aliasToCanonical.has(trimmed)) return;
    this.aliasToCanonical.set(trimmed, canonical);
  }

  private buildAliases(): void {
    const canonicals = [...this.effective.keys()].sort((a, b) => a.localeCompare(b));
    for (const canonical of canonicals) this.aliasToCanonical.set(canonical, canonical);
    for (const canonical of canonicals) {
      const info = this.effective.get(canonical) as ModelInfo;
      if (info.id && info.id !== canonical) this.assignAlias(info.id, canonical);
      for (const alias of info.aliases ?? []) this.assignAlias(alias, canonical);
    }

    const upstreamNames = new Map<string, string>();
    for (const canonical of canonicals) {
      const info = this.effective.get(canonical) as ModelInfo;
      const providers = Object.keys(info.providerConfig ?? {}).sort((a, b) => a.localeCompare(b));
      for (const provider of providers) {
        const upstream = (info.providerConfig?.[provider]?.upstream ?? "").trim();
        if (!upstream || upstreamNames.has(upstream)) continue;
        upstreamNames.set(upstream, canonical);
      }
    }
    for (const upstreamName of [...upstreamNames.keys()].sort((a, b) => a.localeCompare(b))) {
      const canonical = upstreamNames.get(upstreamName) as string;
      if (!this.aliasToCanonical.has(upstreamName)) this.aliasToCanonical.set(upstreamName, canonical);
      const legacy = legacyNvidiaAlias(upstreamName);
      if (legacy !== upstreamName && !this.aliasToCanonical.has(legacy)) {
        this.aliasToCanonical.set(legacy, canonical);
      }
    }

    for (const alias of [...this.aliasToCanonical.keys()].sort((a, b) => a.localeCompare(b))) {
      const canonical = this.aliasToCanonical.get(alias) as string;
      if (alias === canonical) continue;
      const list = this.canonicalToAliases.get(canonical) ?? [];
      list.push(alias);
      this.canonicalToAliases.set(canonical, list);
    }
    for (const [canonical, aliases] of this.canonicalToAliases) {
      this.canonicalToAliases.set(canonical, uniqueSorted(aliases));
    }

    this.buildFoldedAliases();
  }

  private buildFoldedAliases(): void {
    const canonicals = [...this.effective.keys()].sort((a, b) => a.localeCompare(b));
    for (const canonical of canonicals) {
      const key = canonical.toLowerCase();
      if (!this.foldedAliasToCanonical.has(key)) this.foldedAliasToCanonical.set(key, canonical);
    }
    const aliases = [...this.aliasToCanonical.keys()].sort((a, b) => a.localeCompare(b));
    for (const alias of aliases) {
      const key = alias.toLowerCase();
      if (!this.foldedAliasToCanonical.has(key)) {
        this.foldedAliasToCanonical.set(key, this.aliasToCanonical.get(alias) as string);
      }
    }
  }

  resolveAlias(model: string): string {
    const trimmed = model.trim();
    if (!trimmed) return trimmed;
    const direct = this.aliasToCanonical.get(trimmed);
    if (direct !== undefined) return direct;
    const folded = this.foldedAliasToCanonical.get(trimmed.toLowerCase());
    if (folded !== undefined) return folded;
    return trimmed;
  }

  lookupKeys(model: string): string[] {
    const canonical = this.resolveAlias(model);
    return uniqueSortedStable([canonical, ...(this.canonicalToAliases.get(canonical) ?? [])]);
  }

  providersForModel(model: string): string[] {
    const info = this.effective.get(this.resolveAlias(model));
    return info ? [...info.providers] : [];
  }

  isSupported(model: string): boolean {
    return this.providersForModel(model).length > 0;
  }

  isSupportedByProvider(model: string, provider: string): boolean {
    return this.providersForModel(model).includes(provider);
  }

  upstreamModelName(model: string, provider: string): string {
    const canonical = this.resolveAlias(model);
    const info = this.effective.get(canonical);
    if (!info) return canonical;
    const upstream = info.providerConfig?.[provider]?.upstream;
    return upstream && upstream.length > 0 ? upstream : canonical;
  }

  providerAccessRule(model: string, provider: string): ProviderAccessRule | null {
    return this.access.providerAccessRule(model, provider);
  }

  providerModelConfig(model: string, provider: string): ProviderModelConfig | null {
    return this.access.providerModelConfig(model, provider);
  }

  isAuthlessProviderModel(model: string, provider: string): boolean {
    return this.access.isAuthlessProviderModel(model, provider);
  }

  isFreeProviderModel(model: string, provider: string): boolean {
    return this.access.isFreeProviderModel(model, provider);
  }

  authlessProviderModels(): Map<string, string[]> {
    return this.access.authlessProviderModels();
  }

  providerModelMap(provider: string): Map<string, string> {
    const cached = this.providerModelMapCache.get(provider);
    if (cached) return cached;
    const result = new Map<string, string>();
    for (const [canonical, info] of this.effective) {
      if (!info.providers.includes(provider)) continue;
      const upstream = info.providerConfig?.[provider]?.upstream;
      result.set(canonical, upstream && upstream.length > 0 ? upstream : canonical);
    }
    this.providerModelMapCache.set(provider, result);
    return result;
  }

  providerModelSet(provider: string): Set<string> {
    const cached = this.providerModelSetCache.get(provider);
    if (cached) return cached;
    const set = new Set(this.providerModelMap(provider).keys());
    this.providerModelSetCache.set(provider, set);
    return set;
  }

  allModels(): string[] {
    return [...this.effective.entries()]
      .filter(([, info]) => info.providers.length > 0)
      .map(([model]) => model)
      .sort((a, b) => a.localeCompare(b));
  }

  modelsForProvider(provider: string): string[] {
    const values: string[] = [];
    for (const [model, info] of this.effective) {
      if (info.providers.includes(provider)) values.push(model);
    }
    return uniqueSorted(values);
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
    return this.effective.get(this.resolveAlias(model)) ?? null;
  }

  modelFamily(model: string): string {
    return this.modelInfo(model)?.family ?? "";
  }

  modelCost(model: string): ModelCost | null {
    return this.modelInfo(model)?.cost ?? null;
  }

  entries(): Record<string, ModelInfo> {
    const out: Record<string, ModelInfo> = {};
    for (const [modelId, info] of this.effective) out[modelId] = info;
    return out;
  }

  ignoredModels(): string[] {
    return [...this.ignored].sort((a, b) => a.localeCompare(b));
  }

  families(): string[] {
    const families = new Set<string>();
    for (const info of this.effective.values()) {
      if (info.family) families.add(info.family);
    }
    return [...families].sort((a, b) => a.localeCompare(b));
  }

  formatModelsForOpenAI(): Array<Record<string, unknown>> {
    return this.serializer.format();
  }

  isReasoningModel(model: string): boolean {
    return this.serializer.isReasoning(model);
  }

  isVisionModel(model: string): boolean {
    return this.serializer.isVision(model);
  }
}

