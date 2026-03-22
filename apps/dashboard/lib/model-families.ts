/**
 * UI-specific model family configuration.
 *
 * The actual model → family mapping lives in each TOML file under
 * [opendum].family and is exposed via ModelInfo.family from
 * @opendum/shared/proxy/models. This module only defines:
 *   - which families are "featured" (shown as dedicated sections)
 *   - their display order
 *   - anchor IDs for navigation
 */

export const FEATURED_MODEL_FAMILIES = [
  "OpenAI",
  "Claude",
  "Gemini",
  "Qwen",
  "DeepSeek",
  "Kimi",
  "MiniMax",
  "Z.AI",
] as const;

export type FeaturedModelFamily = (typeof FEATURED_MODEL_FAMILIES)[number];
export type ModelFamily = FeaturedModelFamily | "Others";

export const MODEL_FAMILY_ANCHOR_IDS: Record<FeaturedModelFamily, string> = {
  OpenAI: "openai-models",
  Claude: "claude-models",
  Gemini: "gemini-models",
  Qwen: "qwen-models",
  DeepSeek: "deepseek-models",
  Kimi: "kimi-models",
  MiniMax: "minimax-models",
  "Z.AI": "zai-models",
};

const FEATURED_SET: ReadonlySet<string> = new Set<string>(FEATURED_MODEL_FAMILIES);

/**
 * Categorize a raw family string (from TOML) into a ModelFamily.
 * Returns the family as-is when it is a featured family, otherwise "Others".
 */
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
