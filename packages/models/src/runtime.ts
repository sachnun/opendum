import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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
  providerConfig?: Record<string, ProviderModelConfig>;
};

const SUGGESTION_THRESHOLD = 0.7;

type ModelEntry = {
  fileId: string;
  owner: string;
  info: ModelInfo;
};

type SuggestionCandidate = {
  value: string;
  normalized: string;
  tokens: string[];
};

function compactStrings(values: string[] | undefined): string[] {
  if (!values) return [];
  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort((a, b) => a.localeCompare(b));
}

function uniqueSortedStable(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

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
  if (authored.custom && Object.keys(authored.custom).length > 0) {
    merged.custom = { ...(merged.custom ?? {}), ...authored.custom };
  }
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

function isReasoning(model: string, info: ModelInfo): boolean {
  if (info.reasoning == null) return true;
  return info.reasoning;
}

function isVision(info: ModelInfo): boolean {
  if (info.modalities == null) return true;
  return (info.modalities.input ?? []).includes("image");
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
  private readonly suggestionModels: SuggestionCandidate[] = [];
  private readonly suggestionProviders = new Map<string, SuggestionCandidate[]>();

  private constructor(entries: ModelEntry[], options: { familyFromFolder?: boolean } = {}) {
    for (const entry of entries) {
      const info: ModelInfo = { ...entry.info };
      info.id = (info.id ?? "").trim();
      info.providers = compactStrings(info.providers);
      info.aliases = compactStrings(info.aliases);
      if (entry.owner) info.owner = entry.owner;
      if (options.familyFromFolder && !info.family && entry.owner) info.family = entry.owner;
      const modelId = info.id ? info.id : entry.fileId;
      this.mergeModelInfo(modelId, entry.fileId, info);
      if (info.ignored) this.ignored.add(modelId);
    }
    this.buildAliases();
    this.buildSuggestionCandidates();
  }

  static load(dir: string, options: { familyFromFolder?: boolean } = {}): Registry {
    return new Registry(collectModelEntries(dir, resolveGeneratedDir(dir)), options);
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
      merged.providerConfig = { ...(merged.providerConfig ?? {}), ...info.providerConfig };
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

  private buildSuggestionCandidates(): void {
    for (const model of this.allModels()) {
      const candidate = this.newCandidate(model);
      this.suggestionModels.push(candidate);
      const info = this.effective.get(model) as ModelInfo;
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

  private newCandidate(value: string): SuggestionCandidate {
    return makeCandidate(value);
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
    const info = this.effective.get(this.resolveAlias(model));
    if (!info) return null;
    const config = info.providerConfig?.[provider];
    if (!config) return null;
    if (config.minTier || (config.allowedTiers ?? []).length > 0) {
      return { minTier: config.minTier, allowedTiers: [...(config.allowedTiers ?? [])] };
    }
    return null;
  }

  providerModelConfig(model: string, provider: string): ProviderModelConfig | null {
    const info = this.effective.get(this.resolveAlias(model));
    if (!info) return null;
    return info.providerConfig?.[provider] ?? null;
  }

  isAuthlessProviderModel(model: string, provider: string): boolean {
    return this.providerModelConfig(model, provider)?.authless === true;
  }

  isFreeProviderModel(model: string, provider: string): boolean {
    return this.providerModelConfig(model, provider)?.free === true;
  }

  authlessProviderModels(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const [model, info] of this.effective) {
      for (const provider of info.providers) {
        if (!this.isAuthlessProviderModel(model, provider)) continue;
        const list = result.get(provider) ?? [];
        list.push(model);
        result.set(provider, list);
      }
    }
    for (const [provider, list] of result) {
      result.set(provider, [...list].sort((a, b) => a.localeCompare(b)));
    }
    return result;
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
    const term = model.trim();
    if (!term || limit <= 0) return [];
    const query = this.newCandidate(term);

    let useProviderPrefix = false;
    let pool: SuggestionCandidate[] = [];
    if (candidates === null) {
      if (provider) {
        const providerCandidates = this.suggestionProviders.get(provider) ?? [];
        if (providerCandidates.length > 0) {
          pool = providerCandidates;
          useProviderPrefix = true;
        }
      }
      if (pool.length === 0) pool = this.suggestionModels;
    } else {
      pool = uniqueSorted(candidates).map((value) => this.newCandidate(value));
      useProviderPrefix = provider !== null;
    }

    const matches: Array<{ value: string; score: number }> = [];
    for (const candidate of pool) {
      const score = suggestionScore(query, candidate);
      if (score >= SUGGESTION_THRESHOLD) matches.push({ value: candidate.value, score });
    }
    matches.sort((a, b) => (a.score === b.score ? a.value.localeCompare(b.value) : b.score - a.score));

    const result: string[] = [];
    const seen = new Set<string>();
    for (const match of matches) {
      const value = useProviderPrefix && provider ? `${provider}/${match.value}` : match.value;
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
    const data: Array<Record<string, unknown>> = [];
    for (const model of this.allModels()) {
      const info = this.effective.get(model) as ModelInfo;
      const item: Record<string, unknown> = {
        id: model,
        object: "model",
        providers: info.providers,
      };
      if (info.owner) item.owner = info.owner;
      const reasoning = isReasoning(model, info);
      item.reasoning = reasoning;
      if (reasoning && (info.reasoning_effort ?? []).length > 0) {
        item.reasoning_effort = info.reasoning_effort;
      }
      if (info.modalities != null) item.modalities = info.modalities;
      if (
        info.limit != null &&
        ((info.limit.context ?? 0) > 0 || (info.limit.output ?? 0) > 0)
      ) {
        item.limit = info.limit;
      }
      data.push(item);
    }
    return data;
  }

  isReasoningModel(model: string): boolean {
    const info = this.modelInfo(model);
    if (!info) return false;
    return isReasoning(model, info);
  }

  isVisionModel(model: string): boolean {
    const info = this.modelInfo(model);
    if (!info) return false;
    return isVision(info);
  }
}

function makeCandidate(value: string): SuggestionCandidate {
  const normalized = normalizeSuggestionValue(value);
  return { value, normalized, tokens: normalized.split(/\s+/).filter((token) => token.length > 0) };
}

export function suggestionScoreFor(term: string, candidate: string): number {
  return suggestionScore(makeCandidate(term), makeCandidate(candidate));
}

function normalizeSuggestionValue(value: string): string {
  let out = "";
  let lastSeparator = false;
  for (const ch of value.trim().toLowerCase()) {
    if (/[\p{L}\p{N}]/u.test(ch)) {
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

function runeLength(value: string): number {
  return Array.from(value).length;
}

function levenshteinDistance(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let previous = new Array<number>(right.length + 1);
  let current = new Array<number>(right.length + 1);
  for (let j = 0; j <= right.length; j += 1) previous[j] = j;
  for (let i = 0; i < left.length; i += 1) {
    current[0] = i + 1;
    for (let j = 0; j < right.length; j += 1) {
      const cost = left[i] === right[j] ? 0 : 1;
      current[j + 1] = Math.min(current[j]! + 1, previous[j + 1]! + 1, previous[j]! + cost);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[right.length]!;
}

function compactTokenScore(term: string, candidate: string): number {
  if (term === candidate) return 1;
  if (candidate.includes(term) || term.includes(candidate)) {
    let shorter = runeLength(term);
    let longer = runeLength(candidate);
    if (runeLength(candidate) < shorter) {
      shorter = runeLength(candidate);
      longer = runeLength(term);
    }
    return 0.82 + 0.18 * (shorter / longer);
  }
  const maxLen = Math.max(runeLength(term), runeLength(candidate));
  if (maxLen === 0) return 0;
  const score = 1 - levenshteinDistance(term, candidate) / maxLen;
  return score < 0 ? 0 : score;
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

function suggestionScore(term: SuggestionCandidate, candidate: SuggestionCandidate): number {
  const left = term.normalized;
  const right = candidate.normalized;
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (right.includes(left) || left.includes(right)) {
    let shorter = runeLength(left);
    let longer = runeLength(right);
    if (runeLength(right) < shorter) {
      shorter = runeLength(right);
      longer = runeLength(left);
    }
    return 0.8 + 0.2 * (shorter / longer);
  }
  const tokenScore = tokenSuggestionScore(term.tokens, candidate.tokens);
  if (tokenScore > 0) return tokenScore;
  const maxLen = Math.max(runeLength(left), runeLength(right));
  if (maxLen === 0) return 0;
  return 1 - levenshteinDistance(left, right) / maxLen;
}
