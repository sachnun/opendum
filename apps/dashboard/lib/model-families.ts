const FAMILY_BENCHMARK_SCORES: Record<string, number> = {
  Anthropic: 53,
  OpenAI: 53,
  Meta: 48,
  "Z.AI": 45,
  Moonshot: 44,
  xAI: 44,
  Google: 41,
  DeepSeek: 40,
  Qwen: 40,
  "Sapiens AI": 36,
  MiniMax: 30,
  "Nex AGI": 28,
  Upstage: 28,
  Hunyuan: 26,
  "Thinking Machines": 26,
  Xiaomi: 26,
  InclusionAI: 25,
  NVIDIA: 23,
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
  "Qwen",
  "DeepSeek",
  "Moonshot",
  "MiniMax",
  "Xiaomi",
  "xAI",
  "Z.AI",
  "NVIDIA",
  "InclusionAI",
  "Hunyuan",
  "Thinking Machines",
  "Upstage",
  "Sapiens AI",
  "Nex AGI",
] as const;

type FeaturedModelFamily = (typeof FEATURED_MODEL_FAMILIES)[number];
export type ModelFamily = FeaturedModelFamily | "Others";

const MODEL_FAMILY_ANCHOR_IDS: Record<FeaturedModelFamily, string> = {
  OpenAI: "openai-models",
  Anthropic: "anthropic-models",
  Google: "google-models",
  Meta: "meta-models",
  Qwen: "qwen-models",
  DeepSeek: "deepseek-models",
  Moonshot: "moonshot-models",
  MiniMax: "minimax-models",
  Xiaomi: "xiaomi-models",
  xAI: "xai-models",
  "Z.AI": "zai-models",
  NVIDIA: "nvidia-models",
  InclusionAI: "inclusion-ai-models",
  Hunyuan: "hunyuan-models",
  "Thinking Machines": "thinking-machines-models",
  Upstage: "upstage-models",
  "Sapiens AI": "sapiens-ai-models",
  "Nex AGI": "nex-agi-models",
};

export function getModelFamilyAnchorId(family: ModelFamily): string {
  return family === "Others" ? "other-models" : MODEL_FAMILY_ANCHOR_IDS[family];
}

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
