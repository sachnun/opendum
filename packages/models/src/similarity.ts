
const VARIANT_TOKENS: ReadonlySet<string> = new Set([
  "flash", "max", "plus", "mini", "pro", "lite", "nano", "small", "large",
  "medium", "air", "turbo", "code", "coder", "thinking", "instruct", "it",
  "chat", "preview", "alpha", "beta", "latest", "free", "base", "omni",
  "vl", "vision", "reasoning", "high", "low", "tiered", "contributor",
]);

const DEFAULT_THRESHOLD = 0.72;

export interface IndexedModel<TEntry = unknown> {
  id: string;
  name?: string;
  provider?: string;
  entry: TEntry;
  source: string;
}

export interface ResolvedModel<TEntry = unknown> extends IndexedModel<TEntry> {
  matched: string;
  score?: number;
  prefix?: number;
}

export interface ResolveResult<TEntry = unknown> {
  exact: ResolvedModel<TEntry> | null;
  match: ResolvedModel<TEntry> | null;
}

export interface RawIndexEntry<TEntry = unknown> {
  id: string;
  name?: string;
  provider?: string;
  entry: TEntry;
}

export function normalizeName(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/^[^/]*\//, "")
    .replace(/:(free|batch|thinking|online|extended)$/, "")
    .replace(/[._]/g, "-")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function stripDateSuffix(value: string): string {
  const parts = value.split("-");
  const last = parts[parts.length - 1];
  if (parts.length > 1 && last !== undefined && /^\d{4,8}$/.test(last)) {
    return parts.slice(0, -1).join("-");
  }
  return value;
}

export function normalizeKey(value: unknown): string {
  return stripDateSuffix(normalizeName(value));
}

import { ratio, token_sort_ratio } from "fuzzball";

function editSimilarity(left: string, right: string): number {
  return ratio(left, right) / 100;
}

function reorderedSimilarity(left: string, right: string): number {
  return token_sort_ratio(left, right) / 100;
}

export function similarityScore(left: string, right: string): number {
  const a = left.replace(/-/g, "");
  const b = right.replace(/-/g, "");
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  if (hasTokenPrefix(left, right)) return 0.95;
  return Math.max(editSimilarity(left, right), reorderedSimilarity(left, right));
}

function hasTokenPrefix(left: string, right: string): boolean {
  const a = left.split("-").filter(Boolean);
  const b = right.split("-").filter(Boolean);
  if (a.length === 0 || b.length === 0 || a.length === b.length) return false;
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  return shorter.every((token, index) => token === longer[index]);
}

export function familyToken(value: string): string {
  return value.split("-").filter(Boolean)[0] ?? "";
}

function versionTokens(value: string): Set<string> {
  return new Set((value.match(/\d+(?:-\d+)*/g) ?? []).map((token) => token.replace(/-/g, ".")));
}

function variantTokens(value: string): Set<string> {
  return new Set(value.split("-").filter((token) => VARIANT_TOKENS.has(token)));
}

export function isCompatible(left: string, right: string): boolean {
  const leftVersions = versionTokens(left);
  const rightVersions = versionTokens(right);
  if (leftVersions.size > 0 && rightVersions.size > 0) {
    const shared = [...leftVersions].some((version) => rightVersions.has(version));
    if (!shared) return false;
  }

  const leftVariants = variantTokens(left);
  const rightVariants = variantTokens(right);
  const onlyLeft = [...leftVariants].some((token) => !rightVariants.has(token));
  const onlyRight = [...rightVariants].some((token) => !leftVariants.has(token));
  return !(onlyLeft && onlyRight);
}

function sharedPrefixLength(left: string, right: string): number {
  const a = left.split("-");
  const b = right.split("-");
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
  return index;
}

export function buildIndex<TEntry>(
  entries: ReadonlyArray<RawIndexEntry<TEntry>>,
  source: string,
): Map<string, IndexedModel<TEntry>> {
  const index = new Map<string, IndexedModel<TEntry>>();
  for (const item of entries) {
    for (const key of [item.id, item.name]) {
      if (!key) continue;
      const normalized = normalizeKey(key);
      if (!normalized || index.has(normalized)) continue;
      index.set(normalized, {
        id: item.id,
        name: item.name,
        provider: item.provider,
        entry: item.entry,
        source,
      });
    }
  }
  return index;
}

export function resolveCandidates<TEntry>(
  candidates: Iterable<string>,
  index: Map<string, IndexedModel<TEntry>>,
  options: { threshold?: number } = {},
): ResolveResult<TEntry> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  let exact: ResolvedModel<TEntry> | null = null;
  let match: ResolvedModel<TEntry> | null = null;

  for (const candidate of candidates) {
    const key = normalizeKey(candidate);
    if (!key) continue;

    const direct = index.get(key);
    if (direct) {
      exact ??= { ...direct, matched: candidate };
      continue;
    }

    for (const [indexedKey, item] of index) {
      const score = similarityScore(key, indexedKey);
      if (score < threshold || !isCompatible(key, indexedKey)) continue;
      if (score < 0.9 && familyToken(key) !== familyToken(indexedKey)) continue;

      const prefix = sharedPrefixLength(key, indexedKey);
      const better = !match
        || prefix > (match.prefix ?? 0)
        || (prefix === (match.prefix ?? 0) && score > (match.score ?? 0));
      if (better) match = { ...item, score, prefix, matched: candidate };
    }
  }

  return { exact, match };
}
