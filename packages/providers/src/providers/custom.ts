import type { FallbackState } from "#providers/lib/fallback.ts";
import { OpenAICompatibleProvider } from "#providers/providers/openai-compatible.ts";
import type { Logger, UpstreamTransport } from "#providers/api/http.ts";
import type { Provider } from "#providers/model/types.ts";

export type CustomProviderRecord = {
  slug: string;
  baseUrl: string;
  extraHeaders: Record<string, string> | null;
};

export type CustomProviderModelRecord = {
  modelId: string;
  upstream: string | null;
  authless: boolean;
  customFlags: {
    responses_api?: boolean;
    top_p_deprecated?: boolean;
    convert_external_images?: boolean;
  } | null;
};

export const DEFAULT_CUSTOM_SUPPORTED_PARAMS = new Set([
  "model", "messages", "temperature", "top_p", "max_tokens", "max_completion_tokens", "stream",
  "stream_options", "tools", "tool_choice", "parallel_tool_calls", "presence_penalty",
  "frequency_penalty", "n", "stop", "seed", "response_format", "reasoning", "reasoning_effort",
]);

export type CompileCustomProviderOptions = {
  provider: CustomProviderRecord;
  models: CustomProviderModelRecord[];
  transport: UpstreamTransport;
  fallback: FallbackState | null;
  logger?: Logger;
};

export function compileCustomProvider(options: CompileCustomProviderOptions): Provider {
  const byModel = new Map<string, CustomProviderModelRecord>();
  for (const row of options.models) byModel.set(row.modelId, row);

  const upstream = (model: string): string => {
    const row = byModel.get(model);
    const value = row?.upstream?.trim();
    return value ? value : model;
  };
  const flags = (model: string): Record<string, unknown> => {
    const row = byModel.get(model);
    if (!row) return {};
    const custom = row.customFlags;
    if (!custom) return {};
    const record: Record<string, unknown> = {};
    if (custom.responses_api !== undefined) record.responses_api = custom.responses_api;
    if (custom.top_p_deprecated !== undefined) record.top_p_deprecated = custom.top_p_deprecated;
    if (custom.convert_external_images !== undefined) {
      record.convert_external_images = custom.convert_external_images;
    }
    return record;
  };
  const authless = (model: string): boolean => byModel.get(model)?.authless === true;

  return new OpenAICompatibleProvider({
    name: options.provider.slug,
    baseUrl: options.provider.baseUrl,
    supportedParams: DEFAULT_CUSTOM_SUPPORTED_PARAMS,
    trimPrefix: `${options.provider.slug}/`,
    extraHeaders: options.provider.extraHeaders ?? undefined,
    upstreamName: upstream,
    modelFlags: flags,
    isAuthless: authless,
    registry: null,
    transport: options.transport,
    fallback: options.fallback,
    logger: options.logger,
  });
}
