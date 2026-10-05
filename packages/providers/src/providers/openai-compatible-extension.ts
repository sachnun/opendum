import type { ProviderExtension } from "#providers/extension/types.ts";
import { OpenAICompatibleProvider } from "#providers/providers/openai-compatible.ts";

export type OpenAICompatibleExtensionConfig = {
  name: string;
  baseUrl: string;
  fallbackBaseUrl?: string;
  supportedParams: Set<string>;
  trimPrefix: string;
};

export function openAICompatibleExtension(config: OpenAICompatibleExtensionConfig): ProviderExtension {
  return {
    name: config.name,
    create: (deps) =>
      new OpenAICompatibleProvider({
        name: config.name,
        baseUrl: config.baseUrl,
        fallbackBaseUrl: config.fallbackBaseUrl,
        supportedParams: config.supportedParams,
        trimPrefix: config.trimPrefix,
        registry: deps.registry,
        transport: deps.transport,
        fallback: deps.fallback,
        logger: deps.logger,
      }),
  };
}
