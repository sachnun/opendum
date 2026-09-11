/**
 * Model name similarity matching.
 *
 * Matches local model keys against external registries where ids rarely line
 * up exactly. Combines containment, Dice bigram, and Levenshtein scoring with
 * a version/variant compatibility guard so `gemma-4-31b` never matches
 * `gemma-3-12b`.
 */

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

function bigrams(value: string): string[] {
  const text = value.replace(/-/g, "");
  const out: string[] = [];
  for (let index = 0; index < text.length - 1; index += 1) {
    out.push(text.slice(index, index + 2));
  }
  return out;
}

function diceCoefficient(left: string, right: string): number {
  const a = bigrams(left);
  const b = bigrams(right);
  if (a.length === 0 || b.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const gram of a) counts.set(gram, (counts.get(gram) ?? 0) + 1);

  let overlap = 0;
  for (const gram of b) {
    const remaining = counts.get(gram) ?? 0;
    if (remaining > 0) {
      counts.set(gram, remaining - 1);
      overlap += 1;
    }
  }

  return (2 * overlap) / (a.length + b.length);
}

function levenshteinRatio(left: string, right: string): number {
  const m = left.length;
  const n = right.length;
  if (m === 0 || n === 0) return 0;

  let previous = Array.from({ length: n + 1 }, (_, index) => index);
  for (let i = 1; i <= m; i += 1) {
    const current: number[] = [i];
    for (let j = 1; j <= n; j += 1) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }

  return 1 - (previous[n] ?? 0) / Math.max(m, n);
}

export function similarityScore(left: string, right: string): number {
  const a = left.replace(/-/g, "");
  const b = right.replace(/-/g, "");
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.95;
  return Math.max(diceCoefficient(left, right), levenshteinRatio(left, right));
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

      const prefix = sharedPrefixLength(key, indexedKey);
      const better = !match
        || prefix > (match.prefix ?? 0)
        || (prefix === (match.prefix ?? 0) && score > (match.score ?? 0));
      if (better) match = { ...item, score, prefix, matched: candidate };
    }
  }

  return { exact, match };
}
