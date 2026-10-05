export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const MODELSDEV_URL = "https://models.dev/api.json";
export const LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
export const NVIDIA_MODELS_URL = "https://integrate.api.nvidia.com/v1/models";

export const POINTS_PER_USD = 5;

export const PROVIDER_TO_MODELSDEV: Readonly<Record<string, string>> = {
  kilo_code: "kilo",
  openrouter: "openrouter",
  zenmux: "zenmux",
  hyper: "hyper",
  nvidia_nim: "nvidia",
  opencode: "opencode",
  cline: "cline",
  codex: "openai",
  workers_ai: "cloudflare-workers-ai",
};
