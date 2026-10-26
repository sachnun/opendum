import { Effect } from "effect";
import type { Registry } from "@opendum/models/runtime";
import {
  sseCompletion,
  buildPayload,
  sseJson,
} from "../transform/responses.js";
import {
  messagesStream,
  payloadFor,
} from "../transform/anthropic.js";
import { Value, Ids, Responses } from "../core/helpers.js";
import { ModelConfig } from "../core/model-config.js";
import {
  EgressPoster,
  FallbackPoster,
  JSONPoster,
  RequestFailure,
  type FetchLike,
  type Logger,
  type ProviderTransportFailure,
  type UpstreamTransport,
} from "../core/http.js";
import type { FallbackState } from "../core/fallback.js";
import type { Provider, ProviderFailure, ProviderRequest } from "../types.js";

const CHAT_ENDPOINT = "https://opencode.ai/inference/v1/chat/completions";
const RESPONSES_ENDPOINT = "https://opencode.ai/inference/v1/responses";
const MESSAGES_ENDPOINT = "https://opencode.ai/inference/v1/messages";
const FALLBACK_CHAT_ENDPOINT = "https://unroxy.koyeb.app/opencode.ai/inference/v1/chat/completions";
const FALLBACK_RESPONSES_ENDPOINT = "https://unroxy.koyeb.app/opencode.ai/inference/v1/responses";
const FALLBACK_MESSAGES_ENDPOINT = "https://unroxy.koyeb.app/opencode.ai/inference/v1/messages";
const PUBLIC_API_KEY = "public";
const CLIENT = "cli";
const USER_AGENT = "opencode/1.19.4";
const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const REQUIRED_TOOL_NAME = "read";
const FINGERPRINT_DESCRIPTION =
  "Do not call. Reserved OpenCode fingerprint stub with no implementation; use the host application's own tools instead.";
const FINGERPRINT_PARAMETERS = {
  type: "object",
  properties: { description: { type: "string", description: "Reserved; never called." } },
};

export const SUPPORTED_OPENCODE = new Set([
  "model", "messages", "temperature", "top_p", "max_tokens", "max_completion_tokens", "stream",
  "stream_options", "tools", "tool_choice", "parallel_tool_calls", "presence_penalty",
  "frequency_penalty", "n", "stop", "seed", "response_format", "reasoning", "reasoning_effort",
  "prompt_cache_key",
]);

type Json = Record<string, unknown>;

let lastIdMillis = 0;
let idCounter = 0;

function opencodeId(prefix: string, descending: boolean): string {
  const now = Date.now();
  if (now !== lastIdMillis) {
    lastIdMillis = now;
    idCounter = 0;
  }
  idCounter += 1;
  let value = BigInt(now) * 0x1000n + BigInt(idCounter);
  if (descending) value = ~value & 0xffffffffffffffffn;
  const timeBytes = new Uint8Array(6);
  for (let index = 0; index < 6; index += 1) {
    timeBytes[index] = Number((value >> BigInt(40 - 8 * index)) & 0xffn);
  }
  const random = crypto.getRandomValues(new Uint8Array(14));
  let out = `${prefix}_${Ids.hex(timeBytes)}`;
  for (const byte of random) out += ID_ALPHABET[byte % ID_ALPHABET.length];
  return out;
}

const SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const REQUEST_PATTERN = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const SESSION_COUNTER_HEX = "ffe";

function isCanonical(seed: string): boolean {
  if (!SESSION_PATTERN.test(seed)) return false;
  const counter = Number.parseInt(seed.slice(13, 16), 16);
  return counter >= 0xfc0;
}

function canonicalId(prefix: string, seed: string): string {
  const hash = new Bun.CryptoHasher("sha256").update(`${prefix}\u0000${seed}`).digest();
  const time = `${Ids.hex(hash.subarray(0, 6)).slice(0, 9)}${SESSION_COUNTER_HEX}`;
  let out = `${prefix}_${time}`;
  for (const byte of hash.subarray(6, 20)) out += ID_ALPHABET[byte % ID_ALPHABET.length];
  return out;
}

function sessionId(seed: string): string {
  if (isCanonical(seed)) return seed;
  return canonicalId("ses", seed || "opencode-session");
}

function requestId(seed: string): string {
  if (REQUEST_PATTERN.test(seed)) return seed;
  if (!seed) return opencodeId("msg", false);
  return canonicalId("msg", seed);
}

function opencodeHeaders(body: Json): Record<string, string> {
  const session = sessionId(Value.string(body._sessionId));
  const request = requestId(Value.string(body._requestId));
  let project = Value.string(body._projectId);
  if (!project) project = "global";
  return {
    "User-Agent": USER_AGENT,
    "X-Opencode-Project": project,
    "X-Opencode-Session": session,
    "X-Opencode-Session-Id": session,
    "X-Opencode-Request": request,
    "X-Opencode-Client": CLIENT,
  };
}

function fingerprintTool(name: string): Json {
  return {
    type: "function",
    function: {
      name,
      description: FINGERPRINT_DESCRIPTION,
      parameters: FINGERPRINT_PARAMETERS,
    },
  };
}

function isTool(raw: unknown): raw is Json {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}

function toolName(raw: unknown): string {
  if (!isTool(raw)) return "";
  const fn = isTool(raw.function) ? raw.function : {};
  return Value.string(fn.name) || Value.string(raw.name);
}

function toolDescription(raw: unknown): string {
  if (!isTool(raw)) return "";
  const fn = isTool(raw.function) ? raw.function : {};
  return Value.string(fn.description) || Value.string(raw.description);
}

function toolSchema(raw: unknown): Json | null {
  if (!isTool(raw)) return null;
  const fn = isTool(raw.function) ? raw.function : {};
  for (const candidate of [fn.parameters, raw.parameters, raw.input_schema, raw.inputSchema]) {
    if (isTool(candidate)) return candidate;
  }
  return null;
}

function toolParameters(raw: unknown): Json {
  const schema = toolSchema(raw);
  if (!schema) return FINGERPRINT_PARAMETERS;
  if (!isTool(schema.properties) || Object.keys(schema.properties).length === 0) {
    return FINGERPRINT_PARAMETERS;
  }
  return schema;
}

function canonicalTool(raw: unknown): Json {
  const fn: Json = { name: toolName(raw), parameters: toolParameters(raw) };
  const description = toolDescription(raw);
  if (description) fn.description = description;
  return { type: "function", function: fn };
}

function sanitizeTools(raw: unknown): Json[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Json[] = [];
  for (const entry of raw) {
    const name = toolName(entry);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(canonicalTool(entry));
  }
  return out;
}

function fingerprintTools(body: Json): void {
  const tools = sanitizeTools(body.tools);
  if (!tools.some((tool) => toolName(tool) === REQUIRED_TOOL_NAME)) {
    tools.unshift(fingerprintTool(REQUIRED_TOOL_NAME));
  }
  body.tools = tools;
}

function responsesTools(body: Json): void {
  const tools = sanitizeTools(body.tools).map((tool) => {
    const flat: Json = { type: "function", name: toolName(tool), parameters: (tool.function as Json).parameters };
    const description = toolDescription(tool);
    if (description) flat.description = description;
    return flat;
  });
  if (!tools.some((tool) => tool.name === REQUIRED_TOOL_NAME)) {
    tools.unshift({
      type: "function",
      name: REQUIRED_TOOL_NAME,
      description: FINGERPRINT_DESCRIPTION,
      parameters: FINGERPRINT_PARAMETERS,
    });
  }
  body.tools = tools;
}

export type OpencodeOptions = {
  registry: Registry;
  transport: UpstreamTransport;
  fallback: FallbackState | null;
  logger?: Logger;
};

export class OpencodeProvider implements Provider {
  readonly name = "opencode";
  private readonly registry: Registry;
  private readonly transport: UpstreamTransport;
  private readonly fallback: FallbackState | null;
  private readonly logger: Logger | undefined;

  constructor(options: OpencodeOptions) {
    this.registry = options.registry;
    this.transport = options.transport;
    this.fallback = options.fallback;
    this.logger = options.logger;
  }

  authless(): boolean {
    return true;
  }

  makeRequest(request: ProviderRequest): Effect.Effect<Response, ProviderFailure> {
    const body = request.body;
    let model = Value.string(body.model);
    if (model.startsWith("opencode/")) model = model.slice("opencode/".length);
    const modelName = this.registry.upstream(model, "opencode");
    const headers = opencodeHeaders(body);
    body.stream = true;
    if (this.requiresResponsesAPI(model)) responsesTools(body);
    else fingerprintTools(body);
    const direct = this.transport.direct;

    if (this.requiresResponsesAPI(model)) {
      return Effect.gen({ self: this }, function* () {
        const payload = yield* Effect.tryPromise({
          try: () => buildPayload(body, modelName, true, direct),
          catch: (cause) => RequestFailure.transport("opencode", cause),
        });
        const resp = yield* this.post(
          RESPONSES_ENDPOINT,
          FALLBACK_RESPONSES_ENDPOINT,
          payload,
          true,
          headers,
          request.onResponseStart
        );
        if (resp.status < 200 || resp.status >= 300) return resp;
        if (Array.isArray(body._responsesInput)) {
          if (request.stream) return resp;
          if (!resp.body) return resp;
          const data = yield* Effect.promise(() => sseJson(resp.body as ReadableStream<Uint8Array>));
          return Responses.json(200, data);
        }
        if (!resp.body) return resp;
        if (request.stream) return Responses.sse(messagesStream(resp.body, modelName));
        const data = yield* Effect.promise(() =>
          sseCompletion(messagesStream(resp.body as ReadableStream<Uint8Array>, modelName), modelName)
        );
        return Responses.json(200, data);
      });
    }

    if (this.requiresMessagesAPI(model)) {
      return Effect.gen({ self: this }, function* () {
        const payload = yield* Effect.tryPromise({
          try: () => payloadFor(body, modelName, true, direct),
          catch: (cause) => RequestFailure.transport("opencode", cause),
        });
        const resp = yield* this.post(
          MESSAGES_ENDPOINT,
          FALLBACK_MESSAGES_ENDPOINT,
          payload,
          true,
          headers,
          request.onResponseStart
        );
        if (resp.status < 200 || resp.status >= 300) return resp;
        if (!resp.body) return resp;
        if (request.stream) return Responses.sse(messagesStream(resp.body, modelName));
        const data = yield* Effect.promise(() =>
          sseCompletion(
            messagesStream(resp.body as ReadableStream<Uint8Array>, modelName),
            modelName
          )
        );
        return Responses.json(200, data);
      });
    }

    const payload: Json = {};
    for (const [key, value] of Object.entries(body)) {
      if (SUPPORTED_OPENCODE.has(key) && value !== undefined && value !== null) payload[key] = value;
    }
    payload.model = modelName;
    payload.stream = true;
    return Effect.gen({ self: this }, function* () {
      const resp = yield* this.post(
        CHAT_ENDPOINT,
        FALLBACK_CHAT_ENDPOINT,
        payload,
        true,
        headers,
        request.onResponseStart
      );
      if (resp.status < 200 || resp.status >= 300) return resp;
      if (request.stream) return resp;
      if (!resp.body) return resp;
      const data = yield* Effect.promise(() => sseCompletion(resp.body as ReadableStream<Uint8Array>, modelName));
      return Responses.json(200, data);
    });
  }

  responsesNative(model: string): boolean {
    return this.requiresResponsesAPI(model.startsWith("opencode/") ? model.slice("opencode/".length) : model);
  }

  private requiresResponsesAPI(model: string): boolean {
    return new ModelConfig(this.registry, model, "opencode").bool("responses_api");
  }

  private requiresMessagesAPI(model: string): boolean {
    return new ModelConfig(this.registry, model, "opencode").bool("messages_api");
  }

  private post(
    primary: string,
    fallback: string,
    payload: unknown,
    stream: boolean,
    headers: Record<string, string>,
    onStart?: () => void
  ): Effect.Effect<Response, ProviderFailure> {
    const execute = (fetchFn: FetchLike, target: string): Effect.Effect<Response, ProviderTransportFailure> =>
      JSONPoster.withAuth({
        provider: "opencode",
        fetchFn,
        url: target,
        bearer: PUBLIC_API_KEY,
        payload,
        stream,
        headers,
        onStart,
      });
    if (this.transport.egressReady()) {
      return new EgressPoster({
        transport: this.transport,
        state: this.fallback,
        provider: "opencode",
        primary,
        execute,
        logger: this.logger,
        retry: { limited: 5 },
      }).send();
    }
    return new FallbackPoster(this.fallback).send({
      provider: "opencode",
      fetchFn: this.transport.direct,
      state: this.fallback,
      primary,
      fallback,
      execute,
    });
  }
}

export function fallbackUrls(): { chat: string; responses: string } {
  return { chat: FALLBACK_CHAT_ENDPOINT, responses: FALLBACK_RESPONSES_ENDPOINT };
}

export function defaultValue(value: unknown, fallback: string): string {
  return Value.stringOr(value, fallback);
}
