import type { ProviderExtension } from "../../extension/types.js";
import { SUPPORTED_KILO } from "../../openai-compatible.js";
import { openAICompatibleExtension } from "../openai-compatible-extension.js";

export const extension: ProviderExtension = openAICompatibleExtension({
  name: "kilo_code",
  baseUrl: "https://api.kilo.ai/api/gateway",
  fallbackBaseUrl: "https://unroxy.koyeb.app/api.kilo.ai/api/gateway",
  supportedParams: SUPPORTED_KILO,
  trimPrefix: "kilo_code/",
});
