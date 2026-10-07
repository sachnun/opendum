import { randomBytes, createHash } from "node:crypto";
import type { Registry } from "@opendum/models/runtime";
import {
  chatSseToChatCompletion,
  buildResponsesApiPayload,
  responsesSseToChatStream,
  responsesSseToResponsesJson,
} from "./responses-transform.js";
import {
  anthropicMessagesSseToChatStream,
  buildAnthropicMessagesPayload,
} from "./anthropic-transform.js";
import { defaultStringValue, jsonResponse, sseResponse, stringValue } from "./helpers.js";
import { providerConfigBool } from "./model-config.js";
import {
  postExecuteWithFallback,
  postJSONWithHeaders,
  postWithEgressFallback,
  type FetchLike,
  type Logger,
  type UpstreamTransport,
} from "./http.js";
import type { FallbackState } from "./fallback.js";
import type { Provider, ProviderRequest } from "./types.js";

const CHAT_ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const RESPONSES_ENDPOINT = "https://opencode.ai/zen/v1/responses";
const MESSAGES_ENDPOINT = "https://opencode.ai/zen/v1/messages";
const FALLBACK_CHAT_ENDPOINT = "https://unroxy.koyeb.app/opencode.ai/zen/v1/chat/completions";
const FALLBACK_RESPONSES_ENDPOINT = "https://unroxy.koyeb.app/opencode.ai/zen/v1/responses";
const FALLBACK_MESSAGES_ENDPOINT = "https://unroxy.koyeb.app/opencode.ai/zen/v1/messages";
const PUBLIC_API_KEY = "public";
const CLIENT = "cli";
const USER_AGENT = "opencode/1.18.35";
const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const FINGERPRINT_TOOLS = ["bash", "glob", "grep", "read"];
const FINGERPRINT_DESCRIPTION =
  "Do not call. Reserved OpenCode fingerprint stub with no implementation; use the host application's own tools instead.";

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

function canonicalId(prefix: string, seed: string): string {
  const sum = createHash("sha256").update(seed).digest();
  let out = `${prefix}_${sum.subarray(0, 6).toString("hex")}`;
  for (const byte of sum.subarray(6, 20)) out += ID_ALPHABET[byte % ID_ALPHABET.length];
  return out;
}

const SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const REQUEST_PATTERN = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

function sessionId(seed: string): string {
  if (SESSION_PATTERN.test(seed)) return seed;
  if (!seed) return opencodeId("ses", true);
  return canonicalId("ses", seed);
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
    "X-Opencode-Request": request,
    "X-Opencode-Client": CLIENT,
  };
}

function ensureFingerprintTools(body: Json): void {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const present = new Set<string>();
  for (const raw of tools) {
    const tool = (raw ?? {}) as Json;
    const fn = (tool.function ?? {}) as Json;
    const name = stringValue(fn.name) || stringValue(tool.name);
    if (name) present.add(name);
  }
  for (const name of FINGERPRINT_TOOLS) {
    if (present.has(name)) continue;
    tools.push({
      type: "function",
      function: {
        name,
        description: FINGERPRINT_DESCRIPTION,
        parameters: { type: "object", properties: {} },
      },
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

  async makeRequest(request: ProviderRequest): Promise<Response> {
    const body = request.body;
    let model = stringValue(body.model);
    if (model.startsWith("opencode/")) model = model.slice("opencode/".length);
    const modelName = this.registry.upstreamModelName(model, "opencode");
    const headers = opencodeHeaders(body);
    ensureFingerprintTools(body);

    if (this.requiresResponsesAPI(model)) {
      const payload = await buildResponsesApiPayload(body, modelName, true, this.transport.direct);
      const resp = await this.post(RESPONSES_ENDPOINT, FALLBACK_RESPONSES_ENDPOINT, payload, true, headers, request.onUpstreamResponseStart);
      if (resp.status < 200 || resp.status >= 300) return resp;
      if (Array.isArray(body._responsesInput)) {
        if (request.stream) return resp;
        if (!resp.body) return resp;
        const data = await responsesSseToResponsesJson(resp.body);
        return jsonResponse(200, data);
      }
      if (!resp.body) return resp;
      if (request.stream) return sseResponse(responsesSseToChatStream(resp.body, modelName));
      const data = await chatSseToChatCompletion(responsesSseToChatStream(resp.body, modelName), modelName);
      return jsonResponse(200, data);
    }

    if (this.requiresMessagesAPI(model)) {
      const payload = await buildAnthropicMessagesPayload(body, modelName, true, this.transport.direct);
      const resp = await this.post(
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
      const data = await chatSseToChatCompletion(
        anthropicMessagesSseToChatStream(resp.body, modelName),
        modelName
      );
      return jsonResponse(200, data);
    }

    const payload: Json = {};
    for (const [key, value] of Object.entries(body)) {
      if (SUPPORTED_OPENCODE.has(key) && value !== undefined && value !== null) payload[key] = value;
    }
    payload.model = modelName;
    payload.stream = true;
    const resp = await this.post(CHAT_ENDPOINT, FALLBACK_CHAT_ENDPOINT, payload, true, headers, request.onUpstreamResponseStart);
    if (resp.status < 200 || resp.status >= 300) return resp;
    if (request.stream) return resp;
    if (!resp.body) return resp;
    const data = await chatSseToChatCompletion(resp.body, modelName);
    return jsonResponse(200, data);
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
  ): Promise<Response> {
    const execute = (fetchFn: FetchLike, target: string): Promise<Response> =>
      postJSONWithHeaders(fetchFn, target, PUBLIC_API_KEY, payload, stream, headers, onStart);
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
