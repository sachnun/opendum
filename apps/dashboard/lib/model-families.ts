const FAMILY_BENCHMARK_SCORES: Record<string, number> = {
  Anthropic: 96,
  OpenAI: 92,
  "Z.AI": 88,
  Google: 87,
  Qwen: 84,
  DeepSeek: 82,
  MiniMax: 82,
  Meta: 81,
  Moonshot: 81,
  Xiaomi: 80,
  xAI: 77,
  Mistral: 70,
  StepFun: 70,
};

function compareModelFamilies(a: string, b: string): number {
  const aScore = FAMILY_BENCHMARK_SCORES[a] ?? 0;
  const bScore = FAMILY_BENCHMARK_SCORES[b] ?? 0;
  if (aScore !== bScore) return bScore - aScore;
  return a.localeCompare(b);
}

const FEATURED_MODEL_FAMILIES = [
  "OpenAI",
  "Anthropic",
  "Google",
  "Meta",
  "Mistral",
  "Qwen",
  "DeepSeek",
  "Moonshot",
  "MiniMax",
  "Xiaomi",
  "xAI",
  "Z.AI",
  "StepFun",
] as const;

export type FeaturedModelFamily = (typeof FEATURED_MODEL_FAMILIES)[number];
export type ModelFamily = FeaturedModelFamily | "Others";

const MODEL_FAMILY_ANCHOR_IDS: Record<FeaturedModelFamily, string> = {
  OpenAI: "openai-models",
  Anthropic: "anthropic-models",
  Google: "google-models",
  Meta: "meta-models",
  Mistral: "mistral-models",
  Qwen: "qwen-models",
  DeepSeek: "deepseek-models",
  Moonshot: "moonshot-models",
  MiniMax: "minimax-models",
  Xiaomi: "xiaomi-models",
  xAI: "xai-models",
  "Z.AI": "zai-models",
  StepFun: "stepfun-models",
};

const FEATURED_SET: ReadonlySet<string> = new Set<string>(FEATURED_MODEL_FAMILIES);

export function categorizeModelFamily(family: string | undefined): ModelFamily {
  if (family && FEATURED_SET.has(family)) {
    return family as FeaturedModelFamily;
  }

  return "Others";
}

const SORTED_FEATURED_FAMILIES: readonly FeaturedModelFamily[] = [...FEATURED_MODEL_FAMILIES].sort(compareModelFamilies);

export const MODEL_FAMILY_SORT_ORDER: readonly ModelFamily[] = [
  ...SORTED_FEATURED_FAMILIES,
  "Others",
];

export const MODEL_FAMILY_NAV_ITEMS: Array<{ name: ModelFamily; anchorId: string }> = [
  ...SORTED_FEATURED_FAMILIES.map((family) => ({
    name: family,
    anchorId: MODEL_FAMILY_ANCHOR_IDS[family],
  })),
  { name: "Others", anchorId: "other-models" },
];
