import type { ProviderEntry } from "@opendum/providers/core/spec";

export const API_BASE_URL = "https://api.deepai.org/deepai_code";
export const THEOS_PATH = "/theos";
export const MODELS_PATH = "/models";
export const CHAT_PATH = "/chat/completions";
export const RESPONSES_PATH = "/responses";

export const LANE_VERSION = "4";
export const LANE_HEADER = "X-DeepAI-Code-Theos";
export const INSTANCE_HEADER = "X-DeepAI-Code-Instance";
export const API_KEY_HEADER = "api-key";

export const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";

export const PROVIDER: ProviderEntry = {
  spec: {
    key: "deepai",
    slug: "deepai",
    label: "DeepAI",
    category: "api_key",
    showTier: false,
    authMethods: ["api_key"],
    supportsQuota: true,
    apiKeyPortalUrl: "https://deepai.org/dashboard/profile",
    apiKeyPlaceholder: "DeepAI API key",
    displayOrder: 14,
    navOrder: 13,
  },
};
