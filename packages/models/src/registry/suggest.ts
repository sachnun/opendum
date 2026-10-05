export type SuggestionCandidate = {
  value: string;
  normalized: string;
  tokens: string[];
};

export function makeCandidate(value: string): SuggestionCandidate {
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

export function suggestionScore(term: SuggestionCandidate, candidate: SuggestionCandidate): number {
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
