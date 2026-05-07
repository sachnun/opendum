const FEATURED_MODEL_FAMILIES = [
  "OpenAI",
  "Claude",
  "Gemini",
  "Qwen",
  "DeepSeek",
  "Kimi",
  "MiniMax",
  "Xiaomi",
  "Z.AI",
] as const;

export type FeaturedModelFamily = (typeof FEATURED_MODEL_FAMILIES)[number];
export type ModelFamily = FeaturedModelFamily | "Others";

const MODEL_FAMILY_ANCHOR_IDS: Record<FeaturedModelFamily, string> = {
  OpenAI: "openai-models",
  Claude: "claude-models",
  Gemini: "gemini-models",
  Qwen: "qwen-models",
  DeepSeek: "deepseek-models",
  Kimi: "kimi-models",
  MiniMax: "minimax-models",
  Xiaomi: "xiaomi-models",
  "Z.AI": "zai-models",
};

const FEATURED_SET: ReadonlySet<string> = new Set<string>(FEATURED_MODEL_FAMILIES);

export function categorizeModelFamily(family: string | undefined): ModelFamily {
  if (family && FEATURED_SET.has(family)) {
    return family as FeaturedModelFamily;
  }

  return "Others";
}

export const MODEL_FAMILY_SORT_ORDER: readonly ModelFamily[] = [
  ...FEATURED_MODEL_FAMILIES,
  "Others",
];

export const MODEL_FAMILY_NAV_ITEMS: Array<{ name: ModelFamily; anchorId: string }> = [
  ...FEATURED_MODEL_FAMILIES.map((family) => ({
    name: family,
    anchorId: MODEL_FAMILY_ANCHOR_IDS[family],
  })),
  { name: "Others", anchorId: "other-models" },
];
