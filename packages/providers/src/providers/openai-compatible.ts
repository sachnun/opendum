import type { Registry } from "@opendum/models/runtime";
import { stringValue } from "#providers/lib/helpers.ts";
import {
  buildResponsesApiPayload,
  responsesJsonToChatCompletion,
  responsesSseToChatStream,
  type ResponsesNativeProvider,
} from "#providers/transform/responses.ts";
import { convertImageURLsToBase64 } from "#providers/lib/images.ts";
import { providerConfigBool } from "#providers/model/model-config.ts";
import {
  jsonResponse,
  sseResponse,
} from "#providers/lib/helpers.ts";
import type { FallbackState } from "#providers/lib/fallback.ts";
import {
  postExecuteWithFallback,
  postJSON,
  postJSONWithEgressFallback,
  postJSONWithHeaders,
  postJSONWithoutAuth,
  type FetchLike,
  type Logger,
  type UpstreamTransport,
} from "#providers/api/http.ts";
import type { Provider, ProviderAccount, ProviderRequest } from "#providers/model/types.ts";

export const SUPPORTED_ZENMUX = new Set([
  "model", "messages", "temperature", "top_p", "max_tokens", "max_completion_tokens", "stream",
  "stream_options", "tools", "tool_choice", "parallel_tool_calls", "presence_penalty",
  "frequency_penalty", "n", "stop", "seed", "response_format", "reasoning", "reasoning_effort",
]);

export const SUPPORTED_OPENROUTER = new Set([
  "model", "messages", "temperature", "top_p", "max_tokens", "max_completion_tokens", "stream",
  "stream_options", "tools", "tool_choice", "presence_penalty", "frequency_penalty", "n", "stop",
  "seed", "response_format", "reasoning", "reasoning_effort",
]);

export const SUPPORTED_HARBOR = new Set([
  "model", "messages", "temperature", "top_p", "max_tokens", "max_completion_tokens", "stream",
  "stream_options", "tools", "tool_choice", "presence_penalty", "frequency_penalty", "n", "stop",
  "seed", "response_format", "reasoning", "reasoning_effort",
]);

export const SUPPORTED_NVIDIA = new Set([
  "model", "messages", "temperature", "top_p", "max_tokens", "stream", "tools", "tool_choice",
  "presence_penalty", "frequency_penalty", "n", "stop", "seed", "response_format",
]);

export const SUPPORTED_KILO = new Set([
  "model", "messages", "temperature", "top_p", "max_tokens", "max_completion_tokens", "stream",
  "stream_options", "tools", "tool_choice", "presence_penalty", "frequency_penalty", "n", "stop",
  "seed", "response_format", "reasoning", "reasoning_effort",
]);

export const SUPPORTED_HYPER = new Set([
  "model", "messages", "temperature", "top_p", "max_tokens", "max_completion_tokens", "stream",
  "stream_options", "tools", "tool_choice", "parallel_tool_calls", "presence_penalty",
  "frequency_penalty", "n", "stop", "seed", "response_format", "reasoning", "reasoning_effort",
]);

type Json = Record<string, unknown>;

export type OpenAICompatibleOptions = {
  name: string;
  baseUrl: string;
  fallbackBaseUrl?: string;
  supportedParams: Set<string>;
  registry: Registry | null;
  transport: UpstreamTransport;
  fallback: FallbackState | null;
  trimPrefix?: string;
  extraHeaders?: Record<string, string>;
  upstreamName?: (model: string) => string;
  modelFlags?: (model: string) => Record<string, unknown>;
  isAuthless?: (model: string) => boolean;
  logger?: Logger;
};

export class OpenAICompatibleProvider implements Provider, ResponsesNativeProvider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly fallbackBaseUrl: string;
  private readonly supportedParams: Set<string>;
  private readonly registry: Registry | null;
  private readonly transport: UpstreamTransport;
  private readonly fallback: FallbackState | null;
  private readonly trimPrefix: string;
  private readonly extraHeaders: Record<string, string> | undefined;
  private readonly upstreamName: ((model: string) => string) | undefined;
  private readonly modelFlags: ((model: string) => Record<string, unknown>) | undefined;
  private readonly isAuthless: ((model: string) => boolean) | undefined;
  private readonly logger: Logger | undefined;

  constructor(options: OpenAICompatibleOptions) {
    this.name = options.name;
    this.baseUrl = options.baseUrl;
    this.fallbackBaseUrl = options.fallbackBaseUrl ?? "";
    this.supportedParams = options.supportedParams;
    this.registry = options.registry;
    this.transport = options.transport;
    this.fallback = options.fallback;
    this.trimPrefix = options.trimPrefix ?? "";
    this.extraHeaders = options.extraHeaders;
    this.upstreamName = options.upstreamName;
    this.modelFlags = options.modelFlags;
    this.isAuthless = options.isAuthless;
    this.logger = options.logger;
  }

  async makeRequest(request: ProviderRequest): Promise<Response> {
    const body = request.body;
    const model = this.normalizeModel(stringValue(body.model));
    const modelName = this.resolveModel(model);
    const onStart = request.onUpstreamResponseStart;

    if (this.requiresResponsesAPI(model)) {
      const payload = await buildResponsesApiPayload(body, modelName, request.stream, this.transport.direct);
      const resp = await this.post("/responses", request, payload, model, this.extraRequestHeaders(request.account));
      if (resp.status < 200 || resp.status >= 300) return resp;
      if (Array.isArray(body._responsesInput)) return resp;
      if (request.stream && resp.body) {
        return sseResponse(responsesSseToChatStream(resp.body, modelName));
      }
      if (!resp.body) return resp;
      const data = (await resp.json()) as Json;
      return jsonResponse(200, responsesJsonToChatCompletion(data, modelName));
    }

    const payload = this.buildPayload(body, model, modelName, request.stream);
    if (this.convertImages(model)) {
      const messages = payload.messages;
      if (Array.isArray(messages)) {
        payload.messages = await convertImageURLsToBase64(this.transport.direct, messages);
      }
    }
    void onStart;
    return this.post("/chat/completions", request, payload, model, this.extraRequestHeaders(request.account));
  }

  responsesNative(model: string): boolean {
    return this.requiresResponsesAPI(this.normalizeModel(model));
  }

  private async post(
    path: string,
    request: ProviderRequest,
    payload: unknown,
    model: string,
    extraHeaders: Record<string, string> | undefined
  ): Promise<Response> {
    const credentials = request.credentials;
    const authless = credentials.trim() === "" && this.authlessModel(model);
    const onStart = request.onUpstreamResponseStart;
    const execute = (fetchFn: FetchLike, url: string): Promise<Response> => {
      if (authless) return postJSONWithoutAuth(fetchFn, url, payload, request.stream, onStart);
      if (extraHeaders && Object.keys(extraHeaders).length > 0) {
        return postJSONWithHeaders(fetchFn, url, credentials, payload, request.stream, extraHeaders, onStart);
      }
      return postJSON(fetchFn, url, credentials, payload, request.stream, onStart);
    };

    const primary = this.baseUrl + path;
    if (this.transport.egressReady()) {
      return postJSONWithEgressFallback(
        this.transport,
        this.fallback,
        this.name,
        primary,
        credentials,
        payload,
        request.stream,
        extraHeaders,
        onStart,
        this.logger
      );
    }
    const fallbackUrl = this.fallbackBaseUrl ? this.fallbackBaseUrl + path : "";
    return postExecuteWithFallback(this.transport.direct, this.fallback, this.name, primary, fallbackUrl, execute);
  }

  private buildPayload(body: Json, model: string, modelName: string, stream: boolean): Json {
    const payload: Json = {};
    for (const [key, value] of Object.entries(body)) {
      if (this.supportedParams.has(key) && value !== undefined && value !== null) {
        payload[key] = value;
      }
    }
    if (this.flagBool(model, "top_p_deprecated")) delete payload.top_p;
    payload.model = modelName;
    payload.stream = stream;
    return payload;
  }

  private extraRequestHeaders(account: ProviderAccount): Record<string, string> | undefined {
    const headers: Record<string, string> = {};
    if (this.name === "zenmux") headers["x-zenmux-apikey-source"] = "subscription";
    if (this.extraHeaders) {
      for (const [key, value] of Object.entries(this.extraHeaders)) headers[key] = value;
    }
    void account;
    return Object.keys(headers).length > 0 ? headers : undefined;
  }

  private normalizeModel(model: string): string {
    if (this.trimPrefix && model.startsWith(this.trimPrefix)) {
      return model.slice(this.trimPrefix.length);
    }
    return model;
  }

  private resolveModel(model: string): string {
    if (this.upstreamName) return this.upstreamName(model);
    return this.registry ? this.registry.upstreamModelName(model, this.name) : model;
  }

  private requiresResponsesAPI(model: string): boolean {
    return this.flagBool(model, "responses_api");
  }

  private flagBool(model: string, key: string): boolean {
    if (this.modelFlags) return this.modelFlags(model)[key] === true;
    return this.registry ? providerConfigBool(this.registry, model, this.name, key) : false;
  }

  private convertImages(model: string): boolean {
    return this.flagBool(model, "convert_external_images");
  }

  private authlessModel(model: string): boolean {
    if (this.isAuthless) return this.isAuthless(model);
    return this.registry ? this.registry.isAuthlessProviderModel(model, this.name) : false;
  }
}
