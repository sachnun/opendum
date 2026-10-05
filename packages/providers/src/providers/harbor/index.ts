import type { ProviderExtension } from "#providers/extension/types.ts";
import { SUPPORTED_HARBOR } from "#providers/providers/openai-compatible.ts";
import { openAICompatibleExtension } from "#providers/providers/openai-compatible-extension.ts";

export const extension: ProviderExtension = openAICompatibleExtension({
  name: "harbor",
  baseUrl: "https://tokenharbor.ai/v1",
  supportedParams: SUPPORTED_HARBOR,
  trimPrefix: "harbor/",
});
