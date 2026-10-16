import { randomBytes, createHash } from "node:crypto";
import { Effect } from "effect";
import type { Registry } from "@opendum/models/runtime";
import {
  chatSseToChatCompletion,
  buildResponsesApiPayload,
  responsesSseToChatStream,
  responsesSseToResponsesJson,
} from "../transform/responses.js";
import {
  anthropicMessagesSseToChatStream,
  buildAnthropicMessagesPayload,
} from "../transform/anthropic.js";
import { defaultStringValue, jsonResponse, sseResponse, stringValue } from "../core/helpers.js";
import { providerConfigBool } from "../core/model-config.js";
import {
  postExecuteWithFallback,
  postJSONWithHeaders,
  postWithEgressFallback,
  transportFailure,
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
const USER_AGENT = "opencode/1.19.2";
const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const FINGERPRINT_TOOL_NAMES = ["bash", "edit", "glob", "grep", "read", "skill", "task", "todowrite", "webfetch", "websearch", "write"];
const SCHEMA_REQUIRED_TOOL_NAMES = new Set(FINGERPRINT_TOOL_NAMES);
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
  const timeBytes = Buffer.alloc(6);
  for (let index = 0; index < 6; index += 1) {
    timeBytes[index] = Number((value >> BigInt(40 - 8 * index)) & 0xffn);
  }
  const random = randomBytes(14);
  let out = `${prefix}_${timeBytes.toString("hex")}`;
  for (const byte of random) out += ID_ALPHABET[byte % ID_ALPHABET.length];
  return out;
}

const SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const REQUEST_PATTERN = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const SESSION_COUNTER_HEX = "ffe";

/**
 * Whether a session id carries the shape the free tier accepts. The upstream validates the
 * last 12 bits as an inverted per-millisecond counter and refuses anything outside
 * `0xfc0..0xfff`; the remaining 36 bits are not inspected.
 */
function isCanonicalSession(seed: string): boolean {
  if (!SESSION_PATTERN.test(seed)) return false;
  const counter = Number.parseInt(seed.slice(13, 16), 16);
  return counter >= 0xfc0;
}

/**
 * Render an id the free tier accepts, deterministically from a seed so one conversation
 * keeps one upstream session. Only the last 12 bits are constrained, so they are pinned to
 * the counter the official client sends while the rest is derived from the seed.
 */
function canonicalId(prefix: string, seed: string): string {
  const hash = createHash("sha256").update(`${prefix}\u0000${seed}`).digest();
  const time = `${hash.subarray(0, 6).toString("hex").slice(0, 9)}${SESSION_COUNTER_HEX}`;
  let out = `${prefix}_${time}`;
  for (const byte of hash.subarray(6, 20)) out += ID_ALPHABET[byte % ID_ALPHABET.length];
  return out;
}

function sessionId(seed: string): string {
  if (isCanonicalSession(seed)) return seed;
  return canonicalId("ses", seed || "opencode-session");
}

function requestId(seed: string): string {
  if (REQUEST_PATTERN.test(seed)) return seed;
  if (!seed) return opencodeId("msg", false);
  return canonicalId("msg", seed);
}

function opencodeHeaders(body: Json): Record<string, string> {
  const session = sessionId(stringValue(body._sessionId));
  const request = requestId(stringValue(body._requestId));
  let project = stringValue(body._projectId);
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

function toolName(raw: unknown): string {
  const tool = (raw ?? {}) as Json;
  const fn = (tool.function ?? {}) as Json;
  return stringValue(fn.name) || stringValue(tool.name);
}

function hasSchema(raw: unknown): boolean {
  const tool = (raw ?? {}) as Json;
  const fn = (tool.function ?? {}) as Json;
  const parameters = (fn.parameters ?? tool.parameters ?? tool.input_schema ?? tool.inputSchema) as Json | undefined;
  const properties = parameters?.properties;
  return Boolean(properties && typeof properties === "object" && Object.keys(properties as Json).length > 0);
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

/**
 * Bring a Chat Completions body up to the free tier request contract: the upstream
 * answers 403 FreeTierError unless the request streams, declares at least one tool, and
 * carries a `read` tool whose `parameters.properties` is non-empty.
 */
function ensureFingerprintTools(body: Json): void {
  const tools = Array.isArray(body.tools) ? [...body.tools] : [];
  for (let index = 0; index < tools.length; index += 1) {
    const name = toolName(tools[index]);
    if (!SCHEMA_REQUIRED_TOOL_NAMES.has(name) || hasSchema(tools[index])) continue;
    const existing = (tools[index] ?? {}) as Json;
    const fn = (existing.function ?? {}) as Json;
    tools[index] = { ...existing, function: { ...fn, parameters: FINGERPRINT_PARAMETERS } };
  }
  if (!tools.some((tool) => toolName(tool) === REQUIRED_TOOL_NAME)) {
    tools.unshift(fingerprintTool(REQUIRED_TOOL_NAME));
  }
  body.tools = tools;
}

/**
 * The Responses surface takes the flat tool shape, so it needs its own contract pass:
 * streaming plus at least one flat tool with a non-empty parameter object.
 */
function ensureResponsesFingerprintTools(body: Json): void {
  const tools = Array.isArray(body.tools) ? [...body.tools] : [];
  for (let index = 0; index < tools.length; index += 1) {
    const name = toolName(tools[index]);
    if (!SCHEMA_REQUIRED_TOOL_NAMES.has(name) || hasSchema(tools[index])) continue;
    tools[index] = { ...(tools[index] as Json), parameters: FINGERPRINT_PARAMETERS };
  }
  if (!tools.some((tool) => toolName(tool) === REQUIRED_TOOL_NAME)) {
    tools.unshift(fingerprintTool(REQUIRED_TOOL_NAME));
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
    let model = stringValue(body.model);
    if (model.startsWith("opencode/")) model = model.slice("opencode/".length);
    const modelName = this.registry.upstream(model, "opencode");
    const headers = opencodeHeaders(body);
    body.stream = true;
    if (this.requiresResponsesAPI(model)) ensureResponsesFingerprintTools(body);
    else ensureFingerprintTools(body);
    const direct = this.transport.direct;

    if (this.requiresResponsesAPI(model)) {
      return Effect.gen({ self: this }, function* () {
        const payload = yield* Effect.tryPromise({
          try: () => buildResponsesApiPayload(body, modelName, true, direct),
          catch: (cause) => transportFailure("opencode", cause),
        });
        const resp = yield* this.post(
          RESPONSES_ENDPOINT,
          FALLBACK_RESPONSES_ENDPOINT,
          payload,
          true,
          headers,
          request.onUpstreamResponseStart
        );
        if (resp.status < 200 || resp.status >= 300) return resp;
        if (Array.isArray(body._responsesInput)) {
          if (request.stream) return resp;
          if (!resp.body) return resp;
          const data = yield* Effect.promise(() => responsesSseToResponsesJson(resp.body as ReadableStream<Uint8Array>));
          return jsonResponse(200, data);
        }
        if (!resp.body) return resp;
        if (request.stream) return sseResponse(responsesSseToChatStream(resp.body, modelName));
        const data = yield* Effect.promise(() =>
          chatSseToChatCompletion(responsesSseToChatStream(resp.body as ReadableStream<Uint8Array>, modelName), modelName)
        );
        return jsonResponse(200, data);
      });
    }

    if (this.requiresMessagesAPI(model)) {
      return Effect.gen({ self: this }, function* () {
        const payload = yield* Effect.tryPromise({
          try: () => buildAnthropicMessagesPayload(body, modelName, true, direct),
          catch: (cause) => transportFailure("opencode", cause),
        });
        const resp = yield* this.post(
          MESSAGES_ENDPOINT,
          FALLBACK_MESSAGES_ENDPOINT,
          payload,
          true,
          headers,
          request.onUpstreamResponseStart
        );
        if (resp.status < 200 || resp.status >= 300) return resp;
        if (!resp.body) return resp;
        if (request.stream) return sseResponse(anthropicMessagesSseToChatStream(resp.body, modelName));
        const data = yield* Effect.promise(() =>
          chatSseToChatCompletion(
            anthropicMessagesSseToChatStream(resp.body as ReadableStream<Uint8Array>, modelName),
            modelName
          )
        );
        return jsonResponse(200, data);
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
        request.onUpstreamResponseStart
      );
      if (resp.status < 200 || resp.status >= 300) return resp;
      if (request.stream) return resp;
      if (!resp.body) return resp;
      const data = yield* Effect.promise(() => chatSseToChatCompletion(resp.body as ReadableStream<Uint8Array>, modelName));
      return jsonResponse(200, data);
    });
  }

  responsesNative(model: string): boolean {
    return this.requiresResponsesAPI(model.startsWith("opencode/") ? model.slice("opencode/".length) : model);
  }

  private requiresResponsesAPI(model: string): boolean {
    return providerConfigBool(this.registry, model, "opencode", "responses_api");
  }

  private requiresMessagesAPI(model: string): boolean {
    return providerConfigBool(this.registry, model, "opencode", "messages_api");
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
      postJSONWithHeaders("opencode", fetchFn, target, PUBLIC_API_KEY, payload, stream, headers, onStart);
    if (this.transport.egressReady()) {
      return postWithEgressFallback({
        transport: this.transport,
        state: this.fallback,
        provider: "opencode",
        primary,
        execute,
        logger: this.logger,
      });
    }
    return postExecuteWithFallback(this.transport.direct, this.fallback, "opencode", primary, fallback, execute);
  }
}

export function opencodeFallbackUrls(): { chat: string; responses: string } {
  return { chat: FALLBACK_CHAT_ENDPOINT, responses: FALLBACK_RESPONSES_ENDPOINT };
}

export function defaultOpencodeValue(value: unknown, fallback: string): string {
  return defaultStringValue(value, fallback);
}
