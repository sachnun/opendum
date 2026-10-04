export const MODELSDEV_CANONICAL_URL = "https://models.dev/models.json";

export const PROVIDER_TO_MODELSDEV: Readonly<Record<string, string>> = {
  kilo_code: "kilo",
  openrouter: "openrouter",
  zenmux: "zenmux",
  hyper: "hyper",
  nvidia_nim: "nvidia",
  opencode: "opencode",
  cline: "cline",
  codex: "openai",
  workers_ai: "cloudflare-workers-ai",
};

const VARIANT_SUFFIX = /:(?:free|batch|thinking|online|extended|optimized|nitro|floor|latest)$/i;
const SEPARATOR = /[^a-z0-9-]+/g;
const OFFERING_SEPARATOR = "\u0000";

export interface CanonicalModel {
  id: string;
  lab: string;
  bare: string;
  name?: string;
  family?: string;
}

export interface CanonicalIndex {
  models: Map<string, CanonicalModel>;
  offerings: Map<string, string>;
}

export type CanonicalTier = "exact" | "linked" | "fuzzy";

export interface CanonicalResolution {
  id: string;
  lab: string;
  tier: CanonicalTier;
  score: number;
  probe: string;
}

export interface CanonicalSources {
  models?: unknown;
  providers?: unknown;
  openrouter?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function normalizeCanonicalKey(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/^library\//, "")
    .replace(VARIANT_SUFFIX, "")
    .replace(/[._]/g, "-")
    .replace(/[^a-z0-9/]+/g, "-")
    .replace(/\/+$/, "")
    .replace(/^-|-$/g, "");
}

export function canonicalBare(id: string): string {
  const index = id.lastIndexOf("/");
  return index === -1 ? id : id.slice(index + 1);
}

function canonicalLab(id: string): string {
  const index = id.lastIndexOf("/");
  return index === -1 ? "" : id.slice(0, index);
}

function modelKey(value: string): string {
  const bare = canonicalBare(value);
  const key = normalizeCanonicalKey(bare).replace(/\//g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return key;
}

function probeVariants(probe: string): string[] {
  const variants = new Set<string>();
  for (const value of [modelKey(probe), modelKey(canonicalBare(probe))]) {
    if (!value) continue;
    variants.add(value);
    const unfree = value.replace(/-free$/, "");
    if (unfree) variants.add(unfree);
  }
  return [...variants];
}

function tokenList(value: string): string[] {
  return modelKey(value).split("-").filter(Boolean);
}

function isPrefixRelation(left: string[], right: string[]): boolean {
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  if (shorter.length === 0) return false;
  for (let index = 0; index < shorter.length; index += 1) {
    if (shorter[index] !== longer[index]) return false;
  }
  return true;
}

function offeringKeys(providerId: string, offeringId: string): string[] {
  const keys = new Set<string>();
  for (const value of [modelKey(offeringId), modelKey(canonicalBare(offeringId))]) {
    if (!value) continue;
    for (const candidate of [value, value.replace(/-free$/, "")]) {
      if (candidate) keys.add(`${providerId}${OFFERING_SEPARATOR}${candidate}`);
    }
  }
  return [...keys];
}

export function buildCanonicalIndex(sources: CanonicalSources): CanonicalIndex {
  const models = new Map<string, CanonicalModel>();

  const rawModels = asRecord(sources.models);
  if (rawModels) {
    const ordered = Object.keys(rawModels).sort(
      (left, right) => left.length - right.length || left.localeCompare(right),
    );
    for (const id of ordered) {
      const record = asRecord(rawModels[id]);
      const bare = canonicalBare(id);
      const key = modelKey(id);
      if (!key) continue;
      if (models.has(key)) continue;

      models.set(key, {
        id,
        lab: canonicalLab(id),
        bare,
        name: asString(record?.name),
        family: asString(record?.family),
      });
    }
  }

  const offerings = new Map<string, string>();
  const linkOffering = (providerId: string, offeringId: string, canonicalId: string | undefined): void => {
    if (!canonicalId) return;
    const target = models.get(modelKey(canonicalId));
    if (!target) return;
    for (const key of offeringKeys(providerId, offeringId)) {
      if (!offerings.has(key)) offerings.set(key, target.bare);
    }
  };

  const providers = asRecord(sources.providers);
  if (providers) {
    for (const [providerId, value] of Object.entries(providers)) {
      const providerModels = asRecord(asRecord(value)?.models);
      if (!providerModels) continue;
      for (const [offeringId, offering] of Object.entries(providerModels)) {
        linkOffering(providerId, offeringId, asString(asRecord(offering)?.canonical_model_id));
      }
    }
  }

  const openrouter = asRecord(sources.openrouter)?.data;
  if (Array.isArray(openrouter)) {
    for (const item of openrouter) {
      const record = asRecord(item);
      const id = asString(record?.id);
      if (!id) continue;
      linkOffering("openrouter", id, asString(record?.canonical_slug));
    }
  }

  return { models, offerings };
}

export interface ResolveCanonicalOptions {
  provider?: string;
  fallbackProbes?: Iterable<string | null | undefined>;
}

function fuzzyMatches(probe: string, index: CanonicalIndex): CanonicalModel[] {
  const probeTokens = tokenList(probe);
  if (probeTokens.length === 0) return [];

  const matches: CanonicalModel[] = [];
  for (const model of index.models.values()) {
    const candidateTokens = tokenList(model.bare);
    if (candidateTokens.length === 0) continue;
    if (candidateTokens[0] !== probeTokens[0]) continue;
    if (!isPrefixRelation(probeTokens, candidateTokens)) continue;
    matches.push(model);
  }
  return matches;
}

function exactResolution(probe: string, index: CanonicalIndex): CanonicalResolution | null {
  for (const variant of probeVariants(probe)) {
    const model = index.models.get(variant);
    if (model) return { id: model.bare, lab: model.lab, tier: "exact", score: 1, probe };
  }
  return null;
}

function linkedResolution(
  probe: string,
  index: CanonicalIndex,
  provider: string | undefined,
): CanonicalResolution | null {
  if (!provider) return null;
  const providerId = PROVIDER_TO_MODELSDEV[provider] ?? provider;
  for (const variant of probeVariants(probe)) {
    const linked = index.offerings.get(`${providerId}${OFFERING_SEPARATOR}${variant}`);
    if (!linked) continue;
    const model = index.models.get(modelKey(linked));
    if (model) return { id: model.bare, lab: model.lab, tier: "linked", score: 0.95, probe };
  }
  return null;
}

function fuzzyResolution(probe: string, index: CanonicalIndex): CanonicalResolution | null {
  const matches = fuzzyMatches(probe, index);
  if (matches.length !== 1) return null;
  const [model] = matches;
  return { id: model.bare, lab: model.lab, tier: "fuzzy", score: 0.9, probe };
}

export function resolveCanonical(
  probe: string | null | undefined,
  index: CanonicalIndex,
  options: ResolveCanonicalOptions = {},
): CanonicalResolution | null {
  const value = typeof probe === "string" ? probe.trim() : "";
  if (!value) return null;
  if (probeVariants(value).length === 0) return null;

  return exactResolution(value, index)
    ?? linkedResolution(value, index, options.provider)
    ?? fuzzyResolution(value, index);
}

export function resolveCanonicalFrom(
  probes: Iterable<string | null | undefined>,
  index: CanonicalIndex,
  options: ResolveCanonicalOptions = {},
): CanonicalResolution | null {
  const groups = [probes, options.fallbackProbes ?? []];

  for (const group of groups) {
    const values = [...group]
      .map((probe) => (typeof probe === "string" ? probe.trim() : ""))
      .filter((probe) => probe.length > 0 && probeVariants(probe).length > 0);
    if (values.length === 0) continue;

    for (const probe of values) {
      const hit = exactResolution(probe, index);
      if (hit) return hit;
    }
    for (const probe of values) {
      const hit = linkedResolution(probe, index, options.provider);
      if (hit) return hit;
    }
    for (const probe of values) {
      const hit = fuzzyResolution(probe, index);
      if (hit) return hit;
    }
  }
  return null;
}

export function canonicalModelId(
  probe: string | null | undefined,
  index: CanonicalIndex,
  options: ResolveCanonicalOptions = {},
): string | null {
  return resolveCanonical(probe, index, options)?.id ?? null;
}
