import type { ProviderExtension } from "../../extension/types.js";
import { SUPPORTED_HARBOR } from "../../openai-compatible.js";
import { openAICompatibleExtension } from "../openai-compatible-extension.js";

export const extension: ProviderExtension = openAICompatibleExtension({
  name: "harbor",
  baseUrl: "https://tokenharbor.ai/v1",
  supportedParams: SUPPORTED_HARBOR,
  trimPrefix: "harbor/",
});
