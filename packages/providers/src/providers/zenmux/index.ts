import type { ProviderExtension } from "#providers/extension/types.ts";
import { SUPPORTED_ZENMUX } from "#providers/providers/openai-compatible.ts";
import { openAICompatibleExtension } from "#providers/providers/openai-compatible-extension.ts";

export const extension: ProviderExtension = openAICompatibleExtension({
  name: "zenmux",
  baseUrl: "https://zenmux.ai/api/v1",
  supportedParams: SUPPORTED_ZENMUX,
  trimPrefix: "zenmux/",
});
