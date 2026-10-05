
const ACTIVE_PARAMS_SUFFIX = /^a[0-9]+(?:\.[0-9]+)?[kmbt]$/i;
const EXPERT_COUNT_SUFFIX = /^[0-9]+e$/i;
const SIZE_BM = /^[0-9]+(?:\.[0-9]+)?[bm]$/i;
const SIZE_T = /^[0-9]+(?:\.[0-9]+)?t$/i;
const QUANTIZATION = /^(?:fp[0-9]+|int[0-9]+|awq|gptq|gguf|q[0-9]+(?:_[a-z])?)$/i;
const VERSION = /^v[0-9]+(?:\.[0-9]+)*$/i;
const DATE_CANDIDATE = /^[0-9]{4,6}$/;

const BEHAVIOR_DESCRIPTOR =
  /^(?:instruct|it|chat|base|completion|reasoning|thinking|preview|beta|experimental|exp|deprecated)$/i;

const MODALITY_DESCRIPTOR = /^(?:coder|codex|code|vl|vision|omni|multimodal)$/i;

const DESCRIPTOR_TO_META = Object.freeze({
  reasoning: /^(?:thinking|reasoning)$/i,
});

export const PARAMETER_INFO_PATTERNS = Object.freeze({
  ACTIVE_PARAMS_SUFFIX,
  EXPERT_COUNT_SUFFIX,
  SIZE_BM,
  SIZE_T,
  QUANTIZATION,
  VERSION,
  BEHAVIOR_DESCRIPTOR,
  MODALITY_DESCRIPTOR,
});

export function isDateToken(token: string): boolean {
  if (!DATE_CANDIDATE.test(token)) return false;

  if (token.length === 4) {
    const monthFromTail = Number.parseInt(token.slice(-2), 10);
    const monthFromHead = Number.parseInt(token.slice(0, 2), 10);
    const day = Number.parseInt(token.slice(2, 4), 10);
    const yyMM = monthFromTail >= 1 && monthFromTail <= 12;
    const mmDD = monthFromHead >= 1 && monthFromHead <= 12 && day >= 1 && day <= 31;
    return yyMM || mmDD;
  }

  if (token.length === 6) {
    const monthFromTail = Number.parseInt(token.slice(-2), 10);
    const monthFromMiddle = Number.parseInt(token.slice(2, 4), 10);
    const day = Number.parseInt(token.slice(4, 6), 10);
    const yyyyMM = monthFromTail >= 1 && monthFromTail <= 12;
    const yyMMdd = monthFromMiddle >= 1 && monthFromMiddle <= 12 && day >= 1 && day <= 31;
    return yyyyMM || yyMMdd;
  }

  const month = Number.parseInt(token.slice(-2), 10);
  return month >= 1 && month <= 12;
}

function isBehaviorDescriptor(token: string): boolean {
  return BEHAVIOR_DESCRIPTOR.test(token);
}

function isPairableMoESuffix(token: string): boolean {
  return ACTIVE_PARAMS_SUFFIX.test(token) || EXPERT_COUNT_SUFFIX.test(token);
}

export function stripParamInfoKey(
  modelKey: string | null | undefined,
  options: { keepDescriptors?: boolean; keepDates?: boolean } = {},
): string {
  if (typeof modelKey !== "string" || modelKey.length === 0) return modelKey as string;
  const keepDates = options && options.keepDates === true;

  const tokens = modelKey.split(/[-_]/);

  let end = tokens.length;
  while (end > 0) {
    const t = tokens[end - 1];
    if (t === undefined) break;
    if (
      isPairableMoESuffix(t) ||
      SIZE_BM.test(t) ||
      SIZE_T.test(t) ||
      QUANTIZATION.test(t) ||
      (!keepDates && isDateToken(t)) ||
      isBehaviorDescriptor(t)
    ) {
      end -= 1;
      continue;
    }
    break;
  }

const kept = [];
for (let i = 0; i < end; i += 1) {
  const t = tokens[i];
  if (!t) continue;

  if (isPairableMoESuffix(t)) {
    const prev = kept.length > 0 ? kept[kept.length - 1] : null;
    if (prev && (SIZE_BM.test(prev) || SIZE_T.test(prev))) {
      kept.pop();
    }
    continue;
  }

  if (
    SIZE_BM.test(t) ||
    SIZE_T.test(t) ||
    QUANTIZATION.test(t) ||
    isBehaviorDescriptor(t)
  ) {
    continue;
  }

  kept.push(t);
}

  const cleaned = kept.filter(Boolean).join("-");
  return cleaned.length > 0 ? cleaned : modelKey;
}

export interface ModelDescriptors {
  reasoning?: boolean;
}

export function extractDescriptors(modelKey: string | null | undefined): ModelDescriptors {
  if (typeof modelKey !== "string" || modelKey.length === 0) return {};
  const tokens = modelKey.split(/[-_]/);
  const out: ModelDescriptors = {};
  for (const token of tokens) {
    if (DESCRIPTOR_TO_META.reasoning.test(token)) {
      out.reasoning = true;
    }
  }
  return out;
}

export function aliasesFromUpstream(upstreamNames?: string[] | null): string[] {
  const aliases = new Set<string>();
  if (!upstreamNames) return [];

  for (const name of upstreamNames) {
    if (typeof name !== "string" || name.length === 0) continue;
    if (name.includes("/")) {
      aliases.add(name.replace(/\//g, "-"));
    }
    aliases.add(name);
  }

  return [...aliases];
}

export function largestSizeValue(modelKey: string): number {
  if (typeof modelKey !== "string" || modelKey.length === 0) return 0;
  let largest = 0;
  const matches = modelKey.match(/[0-9]+(?:\.[0-9]+)?[bm]/gi) || [];
  for (const match of matches) {
    const numeric = Number.parseFloat(match);
    if (Number.isFinite(numeric)) largest = Math.max(largest, numeric);
  }
  return largest;
}
