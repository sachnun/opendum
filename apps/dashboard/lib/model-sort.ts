import { MODEL_FAMILY_SORT_ORDER, categorizeModelFamily, type ModelFamily } from "./model-families";

export type ModelSortEntry = string | { id?: string; name?: string; family?: string | null };

const FAMILY_ORDER = new Map<ModelFamily, number>(MODEL_FAMILY_SORT_ORDER.map((family, index) => [family, index]));

const INFERRED_FAMILY_RULES: Array<{ test: RegExp; family: string }> = [
  { test: /^gpt-|^gpt\d|^o\d/, family: "OpenAI" },
  { test: /^claude-/, family: "Anthropic" },
  { test: /^gemini-/, family: "Google" },
  { test: /^grok-/, family: "xAI" },
  { test: /^llama|^codellama/, family: "Meta" },
  { test: /^mistral-|^codestral|^devstral|^ministral|^mamba-codestral|^magistral|^mixtral/, family: "Mistral" },
  { test: /^qwen|^qwq-/, family: "Qwen" },
  { test: /^deepseek-/, family: "DeepSeek" },
  { test: /^kimi-/, family: "Moonshot" },
  { test: /^minimax-/, family: "MiniMax" },
  { test: /^mimo-/, family: "Xiaomi" },
  { test: /^glm-/, family: "Z.AI" },
];

const SIZE_UNITS: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

function modelIdOf(entry: ModelSortEntry): string {
  return typeof entry === "string" ? entry : entry.id ?? entry.name ?? "";
}

function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

function tokensFor(modelId: string): string[] {
  return normalizeModelId(modelId).split(/[^a-z0-9.]+/).filter(Boolean);
}

function hasToken(modelId: string, token: string): boolean {
  return tokensFor(modelId).includes(token);
}

function inferModelFamily(modelId: string): ModelFamily {
  const normalized = normalizeModelId(modelId);
  const rule = INFERRED_FAMILY_RULES.find((item) => item.test.test(normalized));
  return categorizeModelFamily(rule?.family);
}

function familyOf(entry: ModelSortEntry): ModelFamily {
  if (typeof entry !== "string" && entry.family) return categorizeModelFamily(entry.family);
  return inferModelFamily(modelIdOf(entry));
}

function familyRank(entry: ModelSortEntry): number {
  return FAMILY_ORDER.get(familyOf(entry)) ?? Number.MAX_SAFE_INTEGER;
}

function compareAsc(left: number, right: number): number {
  return left - right;
}

function compareDesc(left: number, right: number): number {
  return right - left;
}

function compareVersionDesc(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index] ?? 0;
    const rightPart = right[index] ?? 0;
    if (leftPart !== rightPart) return compareDesc(leftPart, rightPart);
  }
  return 0;
}

function compareFallback(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true });
}

function parseVersionParts(value: string | undefined): number[] {
  if (!value) return [];
  return value.split(/[.-]/).map((part) => Number(part)).filter((part) => Number.isFinite(part));
}

function extractVersion(modelId: string, family: ModelFamily): number[] {
  const normalized = normalizeModelId(modelId)
    .replace(/(^|[-_.])\d+(?:\.\d+)?[bkmt](?=$|[-_.])/g, "$1")
    .replace(/(^|[-_.])\d{4,8}(?=$|[-_.])/g, "$1");

  if (family === "OpenAI") {
    const gpt = normalized.match(/^gpt-(\d+(?:\.\d+)?)(o)?(?=$|[-_.])/);
    if (gpt) return gpt[2] ? [Number(gpt[1]), 0] : parseVersionParts(gpt[1]);
    const oSeries = normalized.match(/^o(\d+(?:\.\d+)?)(?=$|[-_.])/);
    if (oSeries) return parseVersionParts(oSeries[1]);
  }

  if (family === "Google") return parseVersionParts(normalized.match(/^gemini-(\d+(?:\.\d+)*)(?=$|[-_.])/)?.[1]);
  if (family === "Qwen") return parseVersionParts(normalized.match(/^qwen(\d+(?:\.\d+)*)(?=$|[-_.])/)?.[1]);
  if (family === "DeepSeek") return parseVersionParts(normalized.match(/^deepseek-[a-z-]*?v?(\d+(?:\.\d+)*)(?=$|[-_.])/)?.[1]);
  if (family === "Moonshot") return parseVersionParts(normalized.match(/^kimi-k(\d+(?:\.\d+)*)(?=$|[-_.])/)?.[1]);
  if (family === "Z.AI") return parseVersionParts(normalized.match(/^glm-?(\d+(?:\.\d+)*)(?=$|[-_.])/)?.[1]);

  return Array.from(normalized.matchAll(/\d+(?:\.\d+)*/g)).flatMap((match) => parseVersionParts(match[0]));
}

function extractSize(modelId: string): number {
  const normalized = normalizeModelId(modelId);
  let largest = 0;
  for (const match of normalized.matchAll(/(\d+(?:\.\d+)?)([bkmt])(?=$|[-_.])/g)) {
    const value = Number(match[1]);
    const unit = match[2] ? SIZE_UNITS[match[2]] ?? 1 : 1;
    if (Number.isFinite(value)) largest = Math.max(largest, value * unit);
  }
  return largest;
}

function extractDate(modelId: string): number {
  const dates = Array.from(normalizeModelId(modelId).matchAll(/(?:^|[-_.])(\d{4,8})(?=$|[-_.])/g)).map((match) => Number(match[1])).filter((value) => Number.isFinite(value));
  return dates.length > 0 ? Math.max(...dates) : 0;
}

function previewRank(modelId: string): number {
  return hasToken(modelId, "preview") || hasToken(modelId, "beta") || hasToken(modelId, "alpha") ? 1 : 0;
}

function contextRank(modelId: string): number {
  return /(?:^|[-_.])\d+m(?=$|[-_.])/.test(normalizeModelId(modelId)) ? 1 : 0;
}

function openAIModelLineRank(modelId: string): number {
  const normalized = normalizeModelId(modelId);
  if (/^gpt-oss-/.test(normalized)) return 2;
  if (/^gpt-/.test(normalized)) return 0;
  if (/^o\d/.test(normalized)) return 1;
  return 3;
}

function isGptOssModel(modelId: string): boolean {
  return /^gpt-oss-/.test(normalizeModelId(modelId));
}

function openAIVariantRank(modelId: string): number {
  if (hasToken(modelId, "codex")) {
    if (hasToken(modelId, "max")) return 1;
    if (hasToken(modelId, "mini")) return 3;
    return 2;
  }
  if (hasToken(modelId, "mini")) return 4;
  if (hasToken(modelId, "nano")) return 5;
  if (hasToken(modelId, "medium")) return 6;
  if (hasToken(modelId, "fast")) return 7;
  return 0;
}

function claudeTierRank(modelId: string): number {
  if (hasToken(modelId, "opus")) return 0;
  if (hasToken(modelId, "sonnet")) return 1;
  if (hasToken(modelId, "haiku")) return 2;
  return 3;
}

function geminiTierRank(modelId: string): number {
  if (hasToken(modelId, "pro")) return 0;
  if (hasToken(modelId, "flash") && hasToken(modelId, "lite")) return 4;
  if (hasToken(modelId, "flash")) return 3;
  return 1;
}

function mistralTierRank(modelId: string): number {
  if (hasToken(modelId, "large")) return 0;
  if (hasToken(modelId, "medium")) return 1;
  if (hasToken(modelId, "codestral") || hasToken(modelId, "devstral")) return 2;
  if (hasToken(modelId, "small")) return 3;
  if (hasToken(modelId, "ministral") || hasToken(modelId, "mini")) return 4;
  return 2;
}

function genericTierRank(modelId: string): number {
  if (hasToken(modelId, "frontier") || hasToken(modelId, "ultra") || hasToken(modelId, "max") || hasToken(modelId, "super")) return 0;
  if (hasToken(modelId, "pro") || hasToken(modelId, "plus") || hasToken(modelId, "large") || hasToken(modelId, "thinking")) return 1;
  if (hasToken(modelId, "medium") || hasToken(modelId, "balanced") || hasToken(modelId, "reasoning")) return 2;
  if (hasToken(modelId, "coder") || hasToken(modelId, "codex") || hasToken(modelId, "code")) return 3;
  if (hasToken(modelId, "flash") || hasToken(modelId, "small") || hasToken(modelId, "mini")) return 4;
  if (hasToken(modelId, "nano") || hasToken(modelId, "lite") || hasToken(modelId, "air") || hasToken(modelId, "free")) return 5;
  return 2;
}

function compareOpenAI(left: string, right: string): number {
  const ossSizeComparison = isGptOssModel(left) && isGptOssModel(right) ? compareDesc(extractSize(left), extractSize(right)) : 0;

  return compareAsc(openAIModelLineRank(left), openAIModelLineRank(right))
    || compareVersionDesc(extractVersion(left, "OpenAI"), extractVersion(right, "OpenAI"))
    || ossSizeComparison
    || compareAsc(openAIVariantRank(left), openAIVariantRank(right))
    || compareDesc(extractSize(left), extractSize(right))
    || compareDesc(extractDate(left), extractDate(right))
    || compareFallback(left, right);
}

function compareClaude(left: string, right: string): number {
  return compareAsc(claudeTierRank(left), claudeTierRank(right))
    || compareVersionDesc(extractVersion(left, "Anthropic"), extractVersion(right, "Anthropic"))
    || compareAsc(contextRank(left), contextRank(right))
    || compareAsc(previewRank(left), previewRank(right))
    || compareFallback(left, right);
}

function compareGemini(left: string, right: string): number {
  return compareAsc(geminiTierRank(left), geminiTierRank(right))
    || compareVersionDesc(extractVersion(left, "Google"), extractVersion(right, "Google"))
    || compareAsc(hasToken(left, "image") ? 1 : 0, hasToken(right, "image") ? 1 : 0)
    || compareAsc(previewRank(left), previewRank(right))
    || compareFallback(left, right);
}

function compareMistral(left: string, right: string): number {
  return compareAsc(mistralTierRank(left), mistralTierRank(right))
    || compareVersionDesc(extractVersion(left, "Mistral"), extractVersion(right, "Mistral"))
    || compareDesc(extractSize(left), extractSize(right))
    || compareDesc(extractDate(left), extractDate(right))
    || compareFallback(left, right);
}

function compareGeneric(left: string, right: string, family: ModelFamily): number {
  return compareVersionDesc(extractVersion(left, family), extractVersion(right, family))
    || compareAsc(genericTierRank(left), genericTierRank(right))
    || compareDesc(extractSize(left), extractSize(right))
    || compareAsc(contextRank(left), contextRank(right))
    || compareAsc(previewRank(left), previewRank(right))
    || compareDesc(extractDate(left), extractDate(right))
    || compareFallback(left, right);
}

function compareWithinFamily(left: string, right: string, family: ModelFamily): number {
  if (family === "OpenAI") return compareOpenAI(left, right);
  if (family === "Anthropic") return compareClaude(left, right);
  if (family === "Google") return compareGemini(left, right);
  if (family === "Mistral") return compareMistral(left, right);
  return compareGeneric(left, right, family);
}

export function compareModelEntries(left: ModelSortEntry, right: ModelSortEntry): number {
  const leftId = modelIdOf(left);
  const rightId = modelIdOf(right);
  const leftFamilyRank = familyRank(left);
  const rightFamilyRank = familyRank(right);

  return compareAsc(leftFamilyRank, rightFamilyRank)
    || compareWithinFamily(leftId, rightId, familyOf(left))
    || compareFallback(leftId, rightId);
}

export function compareModelIds(left: string, right: string): number {
  return compareModelEntries(left, right);
}

export function sortModelIds(models: readonly string[]): string[] {
  return [...models].sort(compareModelIds);
}

export function sortModelEntries<T extends Exclude<ModelSortEntry, string>>(models: readonly T[]): T[] {
  return [...models].sort(compareModelEntries);
}
