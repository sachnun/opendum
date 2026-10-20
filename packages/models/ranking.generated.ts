export type ModelFamilyRankingEntry = {
  name: string;
  anchorId: string;
  score: number;
};

export const MODEL_FAMILY_RANKING: readonly ModelFamilyRankingEntry[] = [
  { name: "Anthropic", anchorId: "anthropic-models", score: 57.6 },
  { name: "OpenAI", anchorId: "openai-models", score: 52.7 },
  { name: "Google", anchorId: "google-models", score: 52.6 },
  { name: "Meta", anchorId: "meta-models", score: 48.1 },
  { name: "Qwen", anchorId: "qwen-models", score: 45.4 },
  { name: "Z.AI", anchorId: "z-ai-models", score: 44.8 },
  { name: "StepFun", anchorId: "step-fun-models", score: 43.7 },
  { name: "Moonshot", anchorId: "moonshot-models", score: 43.6 },
  { name: "MiniMax", anchorId: "minimax-models", score: 42.7 },
  { name: "InclusionAI", anchorId: "inclusion-ai-models", score: 41.1 },
  { name: "DeepSeek", anchorId: "deepseek-models", score: 39.5 },
  { name: "Xiaomi", anchorId: "xiaomi-models", score: 37.9 },
  { name: "NVIDIA", anchorId: "nvidia-models", score: 26.5 },
  { name: "Thinking Machines", anchorId: "thinking-machines-models", score: 25.7 },
  { name: "Hunyuan", anchorId: "hunyuan-models", score: 25.3 },
  { name: "Upstage", anchorId: "upstage-models", score: 24.1 },
];
