export type ModelFamilyRankingEntry = {
  name: string;
  anchorId: string;
  score: number;
};

export const MODEL_FAMILY_RANKING: readonly ModelFamilyRankingEntry[] = [
  { name: "Anthropic", anchorId: "anthropic-models", score: 57.6 },
  { name: "OpenAI", anchorId: "openai-models", score: 52.7 },
  { name: "Meta", anchorId: "meta-models", score: 48.1 },
  { name: "Qwen", anchorId: "qwen-models", score: 45.4 },
  { name: "Z.AI", anchorId: "z-ai-models", score: 44.8 },
  { name: "Moonshot", anchorId: "moonshot-models", score: 43.6 },
  { name: "InclusionAI", anchorId: "inclusion-ai-models", score: 41.1 },
  { name: "Google", anchorId: "google-models", score: 40.9 },
  { name: "DeepSeek", anchorId: "deepseek-models", score: 39.5 },
  { name: "Xiaomi", anchorId: "xiaomi-models", score: 37.9 },
  { name: "MiniMax", anchorId: "minimax-models", score: 29.2 },
  { name: "Thinking Machines", anchorId: "thinking-machines-models", score: 25.7 },
  { name: "Hunyuan", anchorId: "hunyuan-models", score: 25.3 },
  { name: "Upstage", anchorId: "upstage-models", score: 24.1 },
  { name: "NVIDIA", anchorId: "nvidia-models", score: 22.9 },
];
