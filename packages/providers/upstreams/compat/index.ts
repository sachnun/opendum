import { Effect } from "effect";
import type { Registry } from "@opendum/models/runtime";
import { Value, Responses } from "@opendum/providers/helpers";
import {
  buildPayload,
  sseStream,
  type ResponsesNativeProvider,
} from "@opendum/providers/transform/responses";
import { ChatImageInliner } from "@opendum/providers/images";
import { fromMessages } from "@opendum/providers/transform/anthropic";
import { ModelConfig } from "@opendum/providers/model-config";
import type { FallbackState } from "@opendum/providers/fallback";
import {
  EgressJSONPoster,
  FallbackPoster,
  JSONPoster,
  RequestFailure,
  type FetchLike,
  type Logger,
  type ProviderTransportFailure,
  type UpstreamTransport,
} from "@opendum/providers/http";
import { BaseProvider } from "@opendum/providers/provider";
import type { ProviderAccount, ProviderFailure, ProviderRequest } from "@opendum/providers/types";

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

export type CompatOptions = {
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

export class CompatProvider extends BaseProvider implements ResponsesNativeProvider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly fallbackBaseUrl: string;
  private readonly supportedParams: Set<string>;
  private readonly fallback: FallbackState | null;
  private readonly trimPrefix: string;
  private readonly extraHeaders: Record<string, string> | undefined;
  private readonly upstreamName: ((model: string) => string) | undefined;
  private readonly modelFlags: ((model: string) => Record<string, unknown>) | undefined;
  private readonly isAuthless: ((model: string) => boolean) | undefined;
  private readonly logger: Logger | undefined;

  constructor(options: CompatOptions) {
    super({ registry: options.registry, transport: options.transport });
    this.name = options.name;
    this.baseUrl = options.baseUrl;
    this.fallbackBaseUrl = options.fallbackBaseUrl ?? "";
    this.supportedParams = options.supportedParams;
    this.fallback = options.fallback;
    this.trimPrefix = options.trimPrefix ?? "";
    this.extraHeaders = options.extraHeaders;
    this.upstreamName = options.upstreamName;
    this.modelFlags = options.modelFlags;
    this.isAuthless = options.isAuthless;
    this.logger = options.logger;
  }

  makeRequest(request: ProviderRequest): Effect.Effect<Response, ProviderFailure> {
    const body = request.body;
    const model = this.normalizeModel(Value.string(body.model));
    const modelName = this.resolveModel(model);
    const onStart = request.onResponseStart;
    const direct = this.transport.direct;

    if (this.requiresResponsesAPI(model)) {
      return Effect.gen({ self: this }, function* () {
        const payload = yield* Effect.tryPromise({
          try: () => buildPayload(body, modelName, request.stream, direct),
          catch: (cause) => RequestFailure.transport(this.name, cause),
        });
        const resp = yield* this.post("/responses", request, payload, model, this.extraRequestHeaders(request.account));
        if (resp.status < 200 || resp.status >= 300) return resp;
        if (Array.isArray(body._responsesInput)) return resp;
        if (request.stream && resp.body) {
          return Responses.sse(sseStream(resp.body, modelName));
        }
        if (!resp.body) return resp;
        const data = (yield* Effect.promise(() => resp.json())) as Json;
        return Responses.json(200, fromMessages(data, modelName));
      });
    }

    const payload = this.buildPayload(body, model, modelName, request.stream);
    const convertImages = this.convertImages(model);
    void onStart;
    return Effect.gen({ self: this }, function* () {
      if (convertImages) {
        const messages = payload.messages;
        if (Array.isArray(messages)) {
          payload.messages = yield* new ChatImageInliner(direct).run(messages);
        }
      }
      return yield* this.post(
        "/chat/completions",
        request,
        payload,
        model,
        this.extraRequestHeaders(request.account)
      );
    });
  }

  responsesNative(model: string): boolean {
    return this.requiresResponsesAPI(this.normalizeModel(model));
  }

  private post(
    path: string,
    request: ProviderRequest,
    payload: unknown,
    model: string,
    extraHeaders: Record<string, string> | undefined
  ): Effect.Effect<Response, ProviderFailure> {
    const credentials = request.credentials;
    const authless = credentials.trim() === "" && this.authlessModel(model);
    const onStart = request.onResponseStart;
    const name = this.name;
    const options = {
      provider: name,
      url: "",
      bearer: credentials,
      payload,
      stream: request.stream,
      headers: extraHeaders,
      onStart,
    };
    const execute = (fetchFn: FetchLike, url: string): Effect.Effect<Response, ProviderTransportFailure> =>
      authless
        ? JSONPoster.anonymous({ ...options, fetchFn, url })
        : JSONPoster.withAuth({ ...options, fetchFn, url });

    const primary = this.baseUrl + path;
    if (this.transport.egressReady()) {
      return EgressJSONPoster.send({
        transport: this.transport,
        state: this.fallback,
        provider: name,
        url: primary,
        bearer: credentials,
        payload,
        stream: request.stream,
        headers: extraHeaders,
        onStart,
        logger: this.logger,
      });
    }
    const fallbackUrl = this.fallbackBaseUrl ? this.fallbackBaseUrl + path : "";
    return new FallbackPoster(this.fallback).send({
      provider: name,
      fetchFn: this.transport.direct,
      state: this.fallback,
      primary,
      fallback: fallbackUrl,
      execute,
    });
  }

  private buildPayload(body: Json, model: string, modelName: string, stream: boolean): Json {
    const payload: Json = this.filterParams(body, this.supportedParams);
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
    return this.registry ? this.registry.upstream(model, this.name) : model;
  }

  private requiresResponsesAPI(model: string): boolean {
    return this.flagBool(model, "responses_api");
  }

  private flagBool(model: string, key: string): boolean {
    if (this.modelFlags) return this.modelFlags(model)[key] === true;
    return this.registry ? new ModelConfig(this.registry, model, this.name).bool(key) : false;
  }

  private convertImages(model: string): boolean {
    return this.flagBool(model, "convert_external_images");
  }

  private authlessModel(model: string): boolean {
    if (this.isAuthless) return this.isAuthless(model);
    return this.registry ? this.registry.isAuthless(model, this.name) : false;
  }
}
