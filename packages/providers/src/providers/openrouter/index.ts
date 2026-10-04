import type { ProviderExtension } from "#providers/extension/types.ts";
import { SUPPORTED_OPENROUTER } from "#providers/providers/openai-compatible.ts";
import { openAICompatibleExtension } from "#providers/providers/openai-compatible-extension.ts";

export const extension: ProviderExtension = openAICompatibleExtension({
  name: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  supportedParams: SUPPORTED_OPENROUTER,
  trimPrefix: "openrouter/",
});
