import type { ProviderExtension } from "../../extension/types.js";
import { SUPPORTED_HYPER } from "../../openai-compatible.js";
import { openAICompatibleExtension } from "../openai-compatible-extension.js";

export const extension: ProviderExtension = openAICompatibleExtension({
  name: "hyper",
  baseUrl: "https://hyper.charm.land/v1",
  supportedParams: SUPPORTED_HYPER,
  trimPrefix: "hyper/",
});
