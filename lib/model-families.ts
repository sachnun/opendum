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

const MODELS_BY_FAMILY: Record<FeaturedModelFamily, readonly string[]> = {
  OpenAI: [
    "gpt-5.3-codex",
    "gpt-5.2-codex",
    "gpt-5.2",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex",
    "gpt-5.1-codex-mini",
    "gpt-oss-120b-medium",
    "gpt-oss-20b",
  ],
  Claude: [
    "claude-3-haiku",
    "claude-3-7-sonnet",
    "claude-haiku-4-5",
    "claude-sonnet-4",
    "claude-sonnet-4-5",
    "claude-opus-4",
    "claude-opus-4-1",
    "claude-opus-4-5",
    "claude-opus-4-6",
  ],
  Gemini: [
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-thinking",
    "gemini-2.5-flash-lite",
    "gemini-3-flash",
    "gemini-3-flash-preview",
    "gemini-3-pro-high",
    "gemini-3-pro-preview",
    "gemini-3-pro-low",
    "gemini-3-pro-image",
  ],
  Qwen: [
    "qwen3-coder-plus",
    "qwen3-coder-flash",
    "qwen3-max",
    "qwen3-235b-a22b-thinking-2507",
    "qwen3-235b-a22b-instruct",
    "qwen3-235b",
    "qwen3-vl-plus",
    "qwen2.5-vl-72b-instruct",
    "qwen-vl-max",
    "qwen-qwen2.5-coder-32b-instruct",
    "qwen-qwen2.5-coder-7b-instruct",
    "qwen-qwen3-235b-a22b",
    "qwen-qwen3-next-80b-a3b-instruct",
    "qwen-qwq-32b",
    "qwen3-coder-480b",
    "qwen3-coder-next",
    "qwen3-next-80b",
    "qwen3-vl-235b",
    "qwen3-vl-235b-instruct",
  ],
  DeepSeek: [
    "deepseek-v3.2-chat",
    "deepseek-v3.2-reasoner",
    "deepseek-v3.2",
    "deepseek-v3.1",
    "deepseek-v3",
    "deepseek-r1",
    "deepseek-ai-deepseek-coder-6.7b-instruct",
    "deepseek-ai-deepseek-r1",
    "deepseek-ai-deepseek-r1-0528",
    "deepseek-ai-deepseek-v3.1-terminus",
    "deepseek-v3.1-671b",
  ],
  Kimi: [
    "kimi-k2",
    "kimi-k2.5",
    "kimi-k2-0905",
    "kimi-k2-thinking",
    "kimi-k2-1t",
  ],
  MiniMax: [
    "minimax-m2.1",
    "minimax-m2",
  ],
  "Z.AI": [
    "glm-4.7",
    "glm-5",
    "glm-4.6",
    "glm-4.5",
  ],
};

const MODEL_FAMILY_BY_ID = new Map<string, FeaturedModelFamily>();

for (const [family, modelIds] of Object.entries(MODELS_BY_FAMILY) as Array<[
  FeaturedModelFamily,
  readonly string[],
]>) {
  for (const modelId of modelIds) {
    MODEL_FAMILY_BY_ID.set(modelId, family);
  }
}

export function getModelFamily(modelId: string): ModelFamily {
  const normalizedModelId = modelId.trim().toLowerCase();
  return MODEL_FAMILY_BY_ID.get(normalizedModelId) ?? "Others";
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
