import type { ProviderExtension } from "#providers/extension/types.ts";
import { SUPPORTED_HYPER } from "#providers/providers/openai-compatible.ts";
import { openAICompatibleExtension } from "#providers/providers/openai-compatible-extension.ts";

export const extension: ProviderExtension = openAICompatibleExtension({
  name: "hyper",
  baseUrl: "https://hyper.charm.land/v1",
  supportedParams: SUPPORTED_HYPER,
  trimPrefix: "hyper/",
});
