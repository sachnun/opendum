import type { ProviderExtension } from "../../extension/types.js";
import { SUPPORTED_NVIDIA } from "../../openai-compatible.js";
import { openAICompatibleExtension } from "../openai-compatible-extension.js";

export const extension: ProviderExtension = openAICompatibleExtension({
  name: "nvidia_nim",
  baseUrl: "https://integrate.api.nvidia.com/v1",
  supportedParams: SUPPORTED_NVIDIA,
  trimPrefix: "nvidia_nim/",
});
