import type { ProviderExtension } from "../../extension/types.js";
import { SUPPORTED_OPENROUTER } from "../../openai-compatible.js";
import { openAICompatibleExtension } from "../openai-compatible-extension.js";

export const extension: ProviderExtension = openAICompatibleExtension({
  name: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  supportedParams: SUPPORTED_OPENROUTER,
  trimPrefix: "openrouter/",
});
