import type { ProviderExtension } from "#providers/extension/types.ts";
import { SUPPORTED_KILO } from "#providers/providers/openai-compatible.ts";
import { openAICompatibleExtension } from "#providers/providers/openai-compatible-extension.ts";

export const extension: ProviderExtension = openAICompatibleExtension({
  name: "kilo_code",
  baseUrl: "https://api.kilo.ai/api/gateway",
  fallbackBaseUrl: "https://unroxy.koyeb.app/api.kilo.ai/api/gateway",
  supportedParams: SUPPORTED_KILO,
  trimPrefix: "kilo_code/",
});
