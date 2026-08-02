import { readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { resolveModelsDir } from "../config.js";

const suggestionThreshold = 0.7;

export interface ModelMeta {
  reasoning?: boolean;
  toolCall?: boolean;
  vision?: boolean;
}

export interface ProviderAccessRule {
  minTier: string;
  allowedTiers: string[];
}

export interface ProviderModelConfig {
  upstream: string;
  minTier: string;
  allowedTiers: string[];
  authless: boolean;
  aliases: string[];
  custom: Record<string, unknown> | null;
}

export interface ModelInfo {
  id: string;
  providers: string[];
  aliases: string[];
  description: string;
  family: string;
  ignored: boolean;
  meta: ModelMeta | null;
  providerConfig: Record<string, ProviderModelConfig>;
}

interface SuggestionCandidate {
  value: string;
  normalized: string;
  tokens: string[];
}

function parseProviderModelConfig(raw: Record<string, unknown>): ProviderModelConfig {
  const cfg: ProviderModelConfig = {
    upstream: typeof raw.upstream === "string" ? raw.upstream.trim() : "",
    minTier: typeof raw.minTier === "string" ? raw.minTier.trim() : "",
    allowedTiers: compactStrings(raw.allowedTiers),
    authless: raw.authless === true,
    aliases: compactStrings(raw.aliases),
    custom: null,
  };
  const custom: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "upstream" || key === "minTier" || key === "allowedTiers" || key === "authless" || key === "aliases") continue;
    custom[key] = value;
  }
  if (Object.keys(custom).length > 0) cfg.custom = custom;
  return cfg;
}

function parseModelInfo(raw: Record<string, unknown>): ModelInfo {
  const providerConfig: Record<string, ProviderModelConfig> = {};
  const rawConfig = (raw.providerConfig ?? {}) as Record<string, Record<string, unknown>>;
  for (const [provider, value] of Object.entries(rawConfig)) {
    if (value && typeof value === "object") {
      providerConfig[provider] = parseProviderModelConfig(value as Record<string, unknown>);
    }
  }
  return {
    id: typeof raw.id === "string" ? raw.id.trim() : "",
    providers: compactStrings(raw.providers),
    aliases: compactStrings(raw.aliases),
    description: typeof raw.description === "string" ? raw.description : "",
    family: typeof raw.family === "string" ? raw.family : "",
    ignored: raw.ignored === true,
    meta: (raw.meta as ModelMeta | null) ?? null,
    providerConfig,
  };
}

export class Registry {
  private models = new Map<string, ModelInfo>();
  private ignored = new Set<string>();
  private effective = new Map<string, ModelInfo>();
  private aliasToCanonical = new Map<string, string>();
  private canonicalToAliases = new Map<string, string[]>();
  private providerModelMap = new Map<string, Map<string, string>>();
  private providerModelSet = new Map<string, Set<string>>();
  private suggestionModels: SuggestionCandidate[] = [];
  private suggestionProviders = new Map<string, SuggestionCandidate[]>();

  static load(dir?: string): Registry {
    const registry = new Registry();
    const modelsDir = dir ?? resolveModelsDir();
    const modelFiles = collectModelFiles(modelsDir);
    const familyByFileId = collectFamilyByFileId(modelsDir);

    for (const filePath of modelFiles) {
      const fileID = basename(filePath, ".json");
      const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
      const info = parseModelInfo(raw);
      const modelID = info.id !== "" ? info.id : fileID;
      if (info.id === "") info.id = modelID;
      if (fileID !== modelID) info.aliases = uniqueSorted([...info.aliases, fileID]);
      if (info.family === "") info.family = familyByFileId.get(fileID) ?? "";
      registry.mergeModelInfo(modelID, info);
      if (info.ignored) registry.ignored.add(modelID);
    }

    registry.buildAliases();
    registry.buildSuggestionCandidates();
    return registry;
  }

  private mergeModelInfo(modelID: string, info: ModelInfo): void {
    const existing = this.models.get(modelID);
    if (!existing) {
      this.models.set(modelID, info);
      if (!info.ignored) this.effective.set(modelID, info);
      return;
    }
    const merged: ModelInfo = {
      ...existing,
      ...info,
      id: modelID,
      providers: uniqueSorted([...existing.providers, ...info.providers]),
      aliases: uniqueSorted([...existing.aliases, ...info.aliases]),
      description: existing.description || info.description,
      family: existing.family || info.family,
      ignored: existing.ignored && info.ignored,
      meta: existing.meta ?? info.meta,
      providerConfig: { ...existing.providerConfig, ...info.providerConfig },
    };
    this.models.set(modelID, merged);
    if (!merged.ignored) {
      this.effective.set(modelID, merged);
    } else {
      this.effective.delete(modelID);
    }
  }

  private buildAliases(): void {
    for (const [canonical, info] of this.effective) {
      if (info.id !== "" && info.id !== canonical) this.aliasToCanonical.set(info.id, canonical);
      for (const alias of info.aliases) this.aliasToCanonical.set(alias, canonical);
      const upstreamNames = new Set<string>();
      for (const cfg of Object.values(info.providerConfig)) {
        if (cfg.upstream.trim() !== "") upstreamNames.add(cfg.upstream.trim());
      }
      for (const upstreamName of upstreamNames) {
        if (!this.aliasToCanonical.has(upstreamName)) this.aliasToCanonical.set(upstreamName, canonical);
        const legacy = legacyNvidiaAlias(upstreamName);
        if (legacy !== upstreamName && !this.aliasToCanonical.has(legacy)) this.aliasToCanonical.set(legacy, canonical);
      }
    }
    for (const [alias, canonical] of this.aliasToCanonical) {
      const list = this.canonicalToAliases.get(canonical) ?? [];
      list.push(alias);
      this.canonicalToAliases.set(canonical, list);
    }
    for (const canonical of this.canonicalToAliases.keys()) {
      this.canonicalToAliases.set(canonical, uniqueSorted(this.canonicalToAliases.get(canonical) ?? []));
    }
  }

  private buildSuggestionCandidates(): void {
    for (const model of this.allModels()) {
      const candidate = newSuggestionCandidate(model);
      this.suggestionModels.push(candidate);
      const info = this.effective.get(model);
      if (!info) continue;
      for (const provider of info.providers) {
        const list = this.suggestionProviders.get(provider) ?? [];
        list.push(candidate);
        this.suggestionProviders.set(provider, list);
      }
    }
    for (const list of this.suggestionProviders.values()) {
      list.sort((a, b) => a.value.localeCompare(b.value));
    }
  }

  resolveAlias(model: string): string {
    return this.aliasToCanonical.get(model) ?? model;
  }

  lookupKeys(model: string): string[] {
    const canonical = this.resolveAlias(model);
    return uniqueSortedStable([canonical, ...(this.canonicalToAliases.get(canonical) ?? [])]);
  }

  providersForModel(model: string): string[] {
    const info = this.effective.get(this.resolveAlias(model));
    if (!info) return [];
    return [...info.providers];
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
    const upstream = info.providerConfig[provider]?.upstream;
    return upstream || canonical;
  }

  providerAccessRule(model: string, provider: string): ProviderAccessRule | null {
    const info = this.effective.get(this.resolveAlias(model));
    if (!info) return null;
    const cfg = info.providerConfig[provider];
    if (!cfg) return null;
    if (cfg.minTier !== "" || cfg.allowedTiers.length > 0) {
      return { minTier: cfg.minTier, allowedTiers: [...cfg.allowedTiers] };
    }
    return null;
  }

  providerModelConfig(model: string, provider: string): ProviderModelConfig | null {
    const info = this.effective.get(this.resolveAlias(model));
    if (!info) return null;
    return info.providerConfig[provider] ?? null;
  }

  isAuthlessProviderModel(model: string, provider: string): boolean {
    return this.providerModelConfig(model, provider)?.authless === true;
  }

  authlessProviderModels(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const [model, info] of this.effective) {
      for (const provider of info.providers) {
        if (this.isAuthlessProviderModel(model, provider)) {
          const list = result.get(provider) ?? [];
          list.push(model);
          result.set(provider, list);
        }
      }
    }
    for (const list of result.values()) list.sort();
    return result;
  }

  providerModelMapFor(provider: string): Map<string, string> {
    const cached = this.providerModelMap.get(provider);
    if (cached) return cached;
    const result = new Map<string, string>();
    for (const [canonical, info] of this.effective) {
      if (!info.providers.includes(provider)) continue;
      const upstream = info.providerConfig[provider]?.upstream || canonical;
      result.set(canonical, upstream);
    }
    this.providerModelMap.set(provider, result);
    return result;
  }

  providerModelSetFor(provider: string): Set<string> {
    const cached = this.providerModelSet.get(provider);
    if (cached) return cached;
    const set = new Set(this.providerModelMapFor(provider).keys());
    this.providerModelSet.set(provider, set);
    return set;
  }

  allModels(): string[] {
    const models: string[] = [];
    for (const [model, info] of this.effective) {
      if (info.providers.length > 0) models.push(model);
    }
    return models.sort();
  }

  modelsForProvider(provider: string): string[] {
    const values: string[] = [];
    for (const [model, info] of this.effective) {
      if (info.providers.includes(provider)) values.push(model);
    }
    return uniqueSorted(values);
  }

  suggestedModels(model: string, provider: string | null, candidates: string[] | null, limit: number): string[] {
    const term = model.trim();
    if (term === "" || limit <= 0) return [];

    const query = newSuggestionCandidate(term);
    let useProviderPrefix = false;
    let suggestionCandidates: SuggestionCandidate[] = [];

    if (candidates === null) {
      if (provider !== null) {
        const providerCandidates = this.suggestionProviders.get(provider) ?? [];
        if (providerCandidates.length > 0) {
          suggestionCandidates = providerCandidates;
          useProviderPrefix = true;
        }
      }
      if (suggestionCandidates.length === 0) {
        suggestionCandidates = this.suggestionModels;
      }
    } else {
      candidates = uniqueSorted(candidates);
      suggestionCandidates = candidates.map((c) => newSuggestionCandidate(c));
      useProviderPrefix = provider !== null;
    }

    type Match = { value: string; score: number };
    const matches: Match[] = [];
    for (const candidate of suggestionCandidates) {
      const score = suggestionScore(query, candidate);
      if (score >= suggestionThreshold) {
        matches.push({ value: candidate.value, score });
      }
    }
    matches.sort((a, b) => {
      if (a.score === b.score) return a.value.localeCompare(b.value);
      return b.score - a.score;
    });

    const result: string[] = [];
    const seen = new Set<string>();
    for (const item of matches) {
      let value = item.value;
      if (useProviderPrefix && provider !== null) value = `${provider}/${value}`;
      if (seen.has(value)) continue;
      seen.add(value);
      result.push(value);
      if (result.length >= limit) break;
    }
    return result;
  }

  modelInfo(model: string): ModelInfo | null {
    return this.effective.get(this.resolveAlias(model)) ?? null;
  }

  modelFamily(model: string): string {
    return this.modelInfo(model)?.family ?? "";
  }

  formatModelsForOpenAI(): Array<Record<string, unknown>> {
    const now = Math.floor(Date.now() / 1000);
    const data: Array<Record<string, unknown>> = [];
    for (const model of this.allModels()) {
      const info = this.effective.get(model);
      if (!info || info.providers.length === 0) continue;
      data.push({ id: model, object: "model", created: now, owned_by: info.providers.join(",") });
    }
    return data;
  }

  isReasoningModel(model: string): boolean {
    return this.defaultEnabledBoolCapability(model, (meta) => meta.reasoning);
  }

  isToolCallModel(model: string): boolean {
    return this.defaultEnabledBoolCapability(model, (meta) => meta.toolCall);
  }

  isVisionModel(model: string): boolean {
    return this.defaultEnabledBoolCapability(model, (meta) => meta.vision);
  }

  private defaultEnabledBoolCapability(model: string, getCapability: (meta: ModelMeta) => boolean | undefined): boolean {
    const info = this.modelInfo(model);
    if (!info) return false;
    if (info.meta === null) return true;
    const capability = getCapability(info.meta);
    if (capability === undefined) return true;
    return capability;
  }
}

export function normalizeProviderAlias(provider: string): string {
  return provider.trim().toLowerCase();
}

function legacyNvidiaAlias(upstream: string): string {
  let value = upstream.replace(/^library\//, "");
  value = value.replace(/[:/]/g, "-");
  let out = "";
  let lastDash = false;
  for (const ch of value) {
    const valid = /[a-zA-Z0-9._-]/.test(ch);
    const r = valid ? ch : "-";
    if (r === "-") {
      if (lastDash) continue;
      lastDash = true;
    } else {
      lastDash = false;
    }
    out += r;
  }
  return out;
}

function compactStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const result: string[] = [];
  for (const value of values) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed !== "") result.push(trimmed);
  }
  return result;
}

function uniqueSorted(values: string[]): string[] {
  const set = new Set(values.filter((v) => v !== ""));
  return [...set].sort();
}

function uniqueSortedStable(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value) || value === "") continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function collectModelFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) return collectModelFiles(fullPath);
    if (entry.isFile() && entry.name.endsWith(".json")) return [fullPath];
    return [];
  }).sort((a, b) => a.localeCompare(b));
}

function collectFamilyByFileId(modelsDir: string): Map<string, string> {
  const result = new Map<string, string>();
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".json")) {
        result.set(basename(fullPath, ".json"), basename(dir));
      }
    }
  }
  walk(modelsDir);
  return result;
}

function newSuggestionCandidate(value: string): SuggestionCandidate {
  const normalized = normalizeSuggestionValue(value);
  return { value, normalized, tokens: normalized.split(/\s+/).filter(Boolean) };
}

function suggestionScore(term: SuggestionCandidate, candidate: SuggestionCandidate): number {
  const left = term.normalized;
  const right = candidate.normalized;
  if (left === "" || right === "") return 0;
  if (left === right) return 1;
  if (right.includes(left) || left.includes(right)) {
    const shorter = Math.min(left.length, right.length);
    const longer = Math.max(left.length, right.length);
    return 0.8 + 0.2 * (shorter / longer);
  }
  const tokenScore = tokenSuggestionScore(term.tokens, candidate.tokens);
  if (tokenScore > 0) return tokenScore;
  const maxLen = Math.max(left.length, right.length);
  if (maxLen === 0) return 0;
  return 1 - levenshteinDistance(left, right) / maxLen;
}

function tokenSuggestionScore(termTokens: string[], candidateTokens: string[]): number {
  if (termTokens.length === 0 || candidateTokens.length === 0) return 0;
  let total = 0;
  for (const token of termTokens) {
    let best = 0;
    for (const candidateToken of candidateTokens) {
      const score = compactTokenScore(token, candidateToken);
      if (score > best) best = score;
    }
    total += best;
  }
  return total / termTokens.length;
}

function compactTokenScore(term: string, candidate: string): number {
  if (term === candidate) return 1;
  if (candidate.includes(term) || term.includes(candidate)) {
    const shorter = Math.min(term.length, candidate.length);
    const longer = Math.max(term.length, candidate.length);
    return 0.82 + 0.18 * (shorter / longer);
  }
  const maxLen = Math.max(term.length, candidate.length);
  if (maxLen === 0) return 0;
  return Math.max(0, 1 - levenshteinDistance(term, candidate) / maxLen);
}

function normalizeSuggestionValue(value: string): string {
  let out = "";
  let lastSeparator = false;
  for (const ch of value.trim().toLowerCase()) {
    if (/[a-z0-9]/.test(ch)) {
      out += ch;
      lastSeparator = false;
      continue;
    }
    if (!lastSeparator) {
      out += " ";
      lastSeparator = true;
    }
  }
  return out.trim();
}

function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) previous[j] = j;
  for (let i = 0; i < a.length; i++) {
    current[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      current[j + 1] = Math.min(current[j] + 1, previous[j + 1] + 1, previous[j] + cost);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}
