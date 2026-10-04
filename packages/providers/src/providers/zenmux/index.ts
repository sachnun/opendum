import type { ProviderExtension } from "../../extension/types.js";
import { SUPPORTED_ZENMUX } from "../../openai-compatible.js";
import { openAICompatibleExtension } from "../openai-compatible-extension.js";

export const extension: ProviderExtension = openAICompatibleExtension({
  name: "zenmux",
  baseUrl: "https://zenmux.ai/api/v1",
  supportedParams: SUPPORTED_ZENMUX,
  trimPrefix: "zenmux/",
});
