import { uniqueSorted } from "@opendum/models/collections";
import { compareText } from "@opendum/models/compare";

const THRESHOLD = 0.7;

export type Candidate = {
  value: string;
  normalized: string;
  tokens: string[];
};

export type Suggestion = {
  value: string;
  providers: readonly string[];
};

export class Suggester {
  private constructor(
    private readonly models: Candidate[],
    private readonly providers: Map<string, Candidate[]>
  ) {}

  static fromModels(entries: readonly Suggestion[]): Suggester {
    const models: Candidate[] = [];
    const providers = new Map<string, Candidate[]>();
    for (const entry of entries) {
      const candidate = toCandidate(entry.value);
      models.push(candidate);
      for (const provider of entry.providers) {
        const list = providers.get(provider) ?? [];
        list.push(candidate);
        providers.set(provider, list);
      }
    }
    for (const list of providers.values()) {
      list.sort((a, b) => compareText(a.value, b.value));
    }
    return new Suggester(models, providers);
  }

  suggest(model: string, provider: string | null, candidates: string[] | null, limit: number): string[] {
    const term = model.trim();
    if (!term || limit <= 0) return [];
    const query = toCandidate(term);

    let useProviderPrefix = false;
    let pool: Candidate[] = [];
    if (candidates === null) {
      if (provider) {
        const providerCandidates = this.providers.get(provider) ?? [];
        if (providerCandidates.length > 0) {
          pool = providerCandidates;
          useProviderPrefix = true;
        }
      }
      if (pool.length === 0) pool = this.models;
    } else {
      pool = uniqueSorted(candidates).map((value) => toCandidate(value));
      useProviderPrefix = provider !== null;
    }

    const matches: Array<{ value: string; score: number }> = [];
    for (const candidate of pool) {
      const rating = score(query, candidate);
      if (rating >= THRESHOLD) matches.push({ value: candidate.value, score: rating });
    }
    matches.sort((a, b) => (a.score === b.score ? compareText(a.value, b.value) : b.score - a.score));

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
}

export function scoreFor(term: string, candidate: string): number {
  return score(toCandidate(term), toCandidate(candidate));
}

function toCandidate(value: string): Candidate {
  const normalized = normalizeValue(value);
  return { value, normalized, tokens: normalized.split(/\s+/).filter((token) => token.length > 0) };
}

function normalizeValue(value: string): string {
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

function distance(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let previous = Array.from<number>({ length: right.length + 1 });
  let current = Array.from<number>({ length: right.length + 1 });
  for (let j = 0; j <= right.length; j += 1) previous[j] = j;
  for (let i = 0; i < left.length; i += 1) {
    current[0] = i + 1;
    for (let j = 0; j < right.length; j += 1) {
      const cost = left[i] === right[j] ? 0 : 1;
      current[j + 1] = Math.min((current[j] ?? 0) + 1, (previous[j + 1] ?? 0) + 1, (previous[j] ?? 0) + cost);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[right.length] ?? 0;
}

function compactScore(term: string, candidate: string): number {
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
  const score = 1 - distance(term, candidate) / maxLen;
  return score < 0 ? 0 : score;
}

function tokenScore(termTokens: string[], candidateTokens: string[]): number {
  if (termTokens.length === 0 || candidateTokens.length === 0) return 0;
  let total = 0;
  for (const token of termTokens) {
    let best = 0;
    for (const candidateToken of candidateTokens) {
      const score = compactScore(token, candidateToken);
      if (score > best) best = score;
    }
    total += best;
  }
  return total / termTokens.length;
}

function score(term: Candidate, candidate: Candidate): number {
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
  const overlap = tokenScore(term.tokens, candidate.tokens);
  if (overlap > 0) return overlap;
  const maxLen = Math.max(runeLength(left), runeLength(right));
  if (maxLen === 0) return 0;
  return 1 - distance(left, right) / maxLen;
}
