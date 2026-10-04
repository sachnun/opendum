import type { ProviderExtension } from "#providers/extension/types.ts";
import { SUPPORTED_NVIDIA } from "#providers/providers/openai-compatible.ts";
import { openAICompatibleExtension } from "#providers/providers/openai-compatible-extension.ts";

export const extension: ProviderExtension = openAICompatibleExtension({
  name: "nvidia_nim",
  baseUrl: "https://integrate.api.nvidia.com/v1",
  supportedParams: SUPPORTED_NVIDIA,
  trimPrefix: "nvidia_nim/",
});
