import { Duration, Effect } from "effect";
import { buildPayload, chatStream, sseCompletion } from "@opendum/providers/transform/responses";
import { Ids, Responses, Value } from "@opendum/providers/core/helpers";
import { ModelConfig } from "@opendum/providers/core/model-config";
import { StaticProvider, type Json, type ProviderOptions } from "@opendum/providers/core/provider";
import {
  EgressPoster,
  FallbackPoster,
  JSONPoster,
  RequestFailure,
  type FetchLike,
  type Logger,
  type ProviderTransportFailure,
} from "@opendum/providers/core/http";
import type { FallbackState } from "@opendum/providers/core/fallback";
import type { ProviderFailure, ProviderRequest } from "@opendum/providers/types";
import {
  API_BASE_URL,
  API_KEY_HEADER,
  CHAT_PATH,
  DEFAULT_SYSTEM_PROMPT,
  INSTANCE_HEADER,
  LANE_HEADER,
  LANE_VERSION,
  RESPONSES_PATH,
} from "@opendum/providers/auth/deepai/constants";

export const SUPPORTED_DEEPAI = new Set([
  "model", "messages", "temperature", "top_p", "max_tokens", "max_completion_tokens", "stream",
  "stream_options", "tools", "tool_choice", "parallel_tool_calls", "presence_penalty",
  "frequency_penalty", "n", "stop", "seed", "response_format", "reasoning", "reasoning_effort",
  "logprobs", "top_logprobs", "logit_bias", "user", "service_tier",
]);

const CAPACITY_STATUS = new Set([408, 409, 429]);
const CAPACITY_RETRIES = 4;
const CAPACITY_DELAY_MS = 2000;
const MAX_RETRY_DELAY_SECONDS = 30;

const SYSTEM_ROLES = new Set(["system", "developer"]);

function hasSystemMessage(messages: unknown[]): boolean {
  const first = Value.record(messages[0]);
  return first ? SYSTEM_ROLES.has(Value.string(first.role)) : false;
}

function withSystemMessage(messages: unknown[]): unknown[] {
  if (hasSystemMessage(messages)) return messages;
  return [{ role: "system", content: DEFAULT_SYSTEM_PROMPT }, ...messages];
}

function textParts(content: unknown): unknown[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((entry) => {
    const part = Value.record(entry);
    if (!part || typeof part.text !== "string") return [entry];
    if (part.type === "text" || part.type === "input_text") return [{ type: "text", text: part.text }];
    return [entry];
  });
}

function normalizeMessages(messages: unknown[]): unknown[] {
  return messages.map((raw) => {
    const message = Value.record(raw);
    if (!message || !Array.isArray(message.content)) return raw;
    return { ...message, content: textParts(message.content) };
  });
}

function capacityCode(body: string): string {
  const parsed = Value.record(Value.parseJson(body));
  const error = parsed ? Value.record(parsed.error) : null;
  return error ? Value.string(error.code) : "";
}

function capacityDelay(resp: Response, body: string): number | null {
  const header = Number(resp.headers.get("retry-after") ?? "");
  const seconds =
    Number.isFinite(header) && header > 0 ? Math.min(MAX_RETRY_DELAY_SECONDS, header) : CAPACITY_DELAY_MS / 1000;
  const code = capacityCode(body);
  if (resp.status === 409 && code === "session_busy") return seconds * 1000;
  if (resp.status === 429 || resp.status === 408) return seconds * 1000;
  return null;
}

export type DeepAIOptions = ProviderOptions & {
  fallback: FallbackState | null;
  logger?: Logger;
};

export class DeepAIProvider extends StaticProvider {
  readonly name = "deepai";
  private readonly fallback: FallbackState | null;
  private readonly logger: Logger | undefined;
  private readonly instance: string;

  constructor(options: DeepAIOptions) {
    super(options);
    this.fallback = options.fallback;
    this.logger = options.logger;
    this.instance = Ids.hex(crypto.getRandomValues(new Uint8Array(16)));
  }

  makeRequest(request: ProviderRequest): Effect.Effect<Response, ProviderFailure> {
    const model = this.modelOf(Value.string(request.body.model));
    const modelName = this.upstream(model);
    if (this.requiresResponsesAPI(model)) return this.responsesRequest(request, modelName);
    return this.chatRequest(request, modelName);
  }

  responsesNative(model: string): boolean {
    return this.requiresResponsesAPI(this.modelOf(model));
  }

  private chatRequest(request: ProviderRequest, modelName: string): Effect.Effect<Response, ProviderFailure> {
    const body = request.body;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const payload: Json = this.filterParams(body, SUPPORTED_DEEPAI);
    payload.model = modelName;
    payload.messages = normalizeMessages(withSystemMessage(messages));
    payload.stream = request.stream;
    if (request.stream && payload.stream_options === undefined) {
      payload.stream_options = { include_usage: true };
    }
    return this.post(CHAT_PATH, request, payload, request.stream).pipe(
      Effect.flatMap((resp) => (request.stream ? Effect.succeed(resp) : this.buffered(resp, modelName)))
    );
  }

  private responsesRequest(request: ProviderRequest, modelName: string): Effect.Effect<Response, ProviderFailure> {
    const body = request.body;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const normalized: Json = { ...body, messages: normalizeMessages(withSystemMessage(messages)) };
    const chatShape = !Array.isArray(body._responsesInput);
    return Effect.gen({ self: this }, function* () {
      const payload = yield* Effect.tryPromise({
        try: () => buildPayload(normalized, modelName, request.stream, this.transport.direct),
        catch: (cause) => RequestFailure.transport(this.name, cause),
      });
      Reflect.deleteProperty(payload, "prompt_cache_key");
      const resp = yield* this.post(RESPONSES_PATH, request, payload, request.stream);
      if (!chatShape || resp.status < 200 || resp.status >= 300 || !resp.body) return resp;
      if (request.stream) return Responses.sse(chatStream(resp.body, modelName));
      const data = yield* Effect.promise(() =>
        sseCompletion(chatStream(resp.body as ReadableStream<Uint8Array>, modelName), modelName)
      );
      return Responses.json(200, data);
    });
  }

  private buffered(resp: Response, modelName: string): Effect.Effect<Response, ProviderFailure> {
    if (resp.status < 200 || resp.status >= 300 || !resp.body) return Effect.succeed(resp);
    const type = resp.headers.get("content-type") ?? "";
    if (!type.includes("event-stream")) return Effect.succeed(resp);
    return Effect.tryPromise({
      try: () => sseCompletion(resp.body as ReadableStream<Uint8Array>, modelName),
      catch: (cause) => RequestFailure.transport(this.name, cause),
    }).pipe(Effect.map((data) => Responses.json(200, data)));
  }

  private post(
    path: string,
    request: ProviderRequest,
    payload: unknown,
    stream: boolean
  ): Effect.Effect<Response, ProviderFailure> {
    const url = `${API_BASE_URL}${path}`;
    const headers = this.headers(request.credentials);
    const execute = (fetchFn: FetchLike, target: string): Effect.Effect<Response, ProviderTransportFailure> =>
      JSONPoster.anonymous({
        provider: this.name,
        fetchFn,
        url: target,
        bearer: "",
        payload,
        stream,
        headers,
        onStart: request.onResponseStart,
      });
    const send = this.transport.egressReady()
      ? new EgressPoster({
          transport: this.transport,
          state: this.fallback,
          provider: this.name,
          primary: url,
          execute,
          logger: this.logger,
        }).send()
      : new FallbackPoster(this.fallback).send({
          provider: this.name,
          fetchFn: this.transport.direct,
          state: this.fallback,
          primary: url,
          fallback: "",
          execute,
        });
    return send.pipe(Effect.flatMap((resp) => this.retryCapacity(resp, execute, url, CAPACITY_RETRIES)));
  }

  private retryCapacity(
    resp: Response,
    execute: (fetchFn: FetchLike, target: string) => Effect.Effect<Response, ProviderTransportFailure>,
    url: string,
    attempts: number
  ): Effect.Effect<Response, ProviderFailure> {
    if (attempts <= 0 || !CAPACITY_STATUS.has(resp.status)) return Effect.succeed(resp);
    return Effect.gen({ self: this }, function* () {
      const body = yield* Effect.promise(() => resp.clone().text());
      const delay = capacityDelay(resp, body);
      if (delay === null) return resp;
      yield* Effect.promise(async () => {
        await resp.body?.cancel();
      });
      yield* Effect.sleep(Duration.millis(delay));
      const next = yield* execute(this.transport.direct, url);
      return yield* this.retryCapacity(next, execute, url, attempts - 1);
    });
  }

  private headers(credentials: string): Record<string, string> {
    return {
      [API_KEY_HEADER]: credentials.trim(),
      [LANE_HEADER]: LANE_VERSION,
      [INSTANCE_HEADER]: this.instance,
    };
  }

  private modelOf(model: string): string {
    const prefix = `${this.name}/`;
    return model.startsWith(prefix) ? model.slice(prefix.length) : model;
  }

  private requiresResponsesAPI(model: string): boolean {
    return new ModelConfig(this.registry, model, this.name).bool("responses_api");
  }
}
