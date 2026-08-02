import type { Registry } from "../registry/index.js";
import { jsonResponse, sseResponse, stringValue, postJSON, postJSONWithHeaders, postJSONWithoutAuth, readAllJSON, iterateLines, randomID } from "./http.js";
import { convertImageURLsToBase64 } from "./images.js";
import { normalizeResponsesInput, messagesToResponsesInput, convertToolsForResponses, responsesJSONToChatCompletion, chatCompletionToResponsesJSON } from "./responses_transform.js";
import { normalizeToolChoiceHelper, providerConfigBoolHelper } from "./providers-helpers.js";
import { transformResponsesToChatGen, transformChatToResponsesGen } from "./sse-transforms.js";
import type { HttpClient, Provider, ProviderAccountLike, RequestContext, UpstreamResponse } from "./types.js";
import { markUpstreamResponseStarted } from "./latency.js";

export const opencodeChatCompletionsEndpoint = "https://unroxy.koyeb.app/opencode.ai/zen/v1/chat/completions";
export const opencodePublicAPIKey = "public";
export const opencodeClient = "cli";
export const opencodeUserAgent = "opencode/1.15.8";

const oauthRefreshBuffer = 3 * 3600 * 1000;

export function defaultRefreshBuffer(): number {
  return oauthRefreshBuffer;
}

export function refreshBufferFor(provider: Provider): number {
  const p = provider as unknown as { refreshBuffer?: () => number };
  if (typeof p.refreshBuffer === "function") {
    return p.refreshBuffer();
  }
  return oauthRefreshBuffer;
}

const supportedOpenRouter = set("model", "messages", "temperature", "top_p", "max_tokens", "max_completion_tokens", "stream", "stream_options", "tools", "tool_choice", "presence_penalty", "frequency_penalty", "n", "stop", "seed", "response_format", "reasoning", "reasoning_effort");
const supportedNvidia = set("model", "messages", "temperature", "top_p", "max_tokens", "stream", "tools", "tool_choice", "presence_penalty", "frequency_penalty", "n", "stop", "seed", "response_format");
const supportedKilo = set("model", "messages", "temperature", "top_p", "max_tokens", "max_completion_tokens", "stream", "stream_options", "tools", "tool_choice", "presence_penalty", "frequency_penalty", "n", "stop", "seed", "response_format", "reasoning", "reasoning_effort");
const supportedZenmux = set("model", "messages", "temperature", "top_p", "max_tokens", "max_completion_tokens", "stream", "stream_options", "tools", "tool_choice", "parallel_tool_calls", "presence_penalty", "frequency_penalty", "n", "stop", "seed", "response_format", "reasoning", "reasoning_effort");
const supportedSiliconFlow = set("model", "messages", "temperature", "top_p", "top_k", "max_tokens", "stream", "stream_options", "tools", "tool_choice", "frequency_penalty", "n", "stop", "response_format", "min_p", "enable_thinking", "thinking_budget");
const supportedOpencode = set("model", "messages", "temperature", "top_p", "max_tokens", "max_completion_tokens", "stream", "stream_options", "tools", "tool_choice", "parallel_tool_calls", "presence_penalty", "frequency_penalty", "n", "stop", "seed", "response_format", "reasoning", "reasoning_effort");
const supportedWorkersAI = set("model", "messages", "audio", "temperature", "top_p", "max_tokens", "max_completion_tokens", "stream", "stream_options", "tools", "tool_choice", "parallel_tool_calls", "function_call", "functions", "presence_penalty", "frequency_penalty", "stop", "seed", "response_format", "reasoning_effort", "chat_template_kwargs", "modalities", "metadata", "prediction", "logit_bias", "logprobs", "top_logprobs", "store", "service_tier", "user", "web_search_options", "n");

export class OpenAICompatibleProvider implements Provider {
  constructor(
    private opts: {
      name: string;
      baseURL: string;
      supportedParams: Set<string>;
      registry: Registry | null;
      trimPrefix: string;
    },
  ) {}

  async makeRequest(client: HttpClient, ctx: RequestContext, credentials: string, account: ProviderAccountLike, body: Record<string, unknown>, stream: boolean): Promise<UpstreamResponse> {
    const model = this.normalizeModel(stringValue(body["model"]));
    const modelName = this.resolveModel(model);
    const extraHeaders = this.extraRequestHeaders(account);

    if (this.requiresResponsesAPI(model)) {
      const payload = this.buildResponsesPayload(body, modelName, stream);
      let resp = await this.post(client, ctx, this.opts.baseURL + "/responses", credentials, payload, stream, model, extraHeaders);
      if (resp.status < 200 || resp.status >= 300) return resp;
      if (Array.isArray(body["_responsesInput"])) return resp;
      if (stream) {
        return sseResponse(transformResponsesToChatGen(resp.body, modelName));
      }
      const data = await readAllJSON(resp.body);
      return jsonResponse(200, responsesJSONToChatCompletion(data ?? {}, modelName));
    }

    const payload = this.buildPayload(body, model, modelName, stream);
    let resp = await this.post(client, ctx, this.opts.baseURL + "/chat/completions", credentials, payload, stream, model, extraHeaders);
    if (resp.status < 200 || resp.status >= 300) return resp;
    if (Array.isArray(body["_responsesInput"])) {
      if (stream) {
        return sseResponse(transformChatToResponsesGen(resp.body, modelName));
      }
      const data = await readAllJSON(resp.body);
      return jsonResponse(200, chatCompletionToResponsesJSON(data ?? {}, modelName));
    }
    return resp;
  }

  extraRequestHeaders(account: ProviderAccountLike): Record<string, string> | null {
    if (this.opts.name === "zenmux") {
      return { "x-zenmux-apikey-source": "subscription" };
    }
    return null;
  }

  async post(client: HttpClient, ctx: RequestContext, url: string, credentials: string, payload: Record<string, unknown>, stream: boolean, model: string, extraHeaders: Record<string, string> | null): Promise<UpstreamResponse> {
    if (credentials.trim() === "" && this.opts.registry && this.opts.registry.isAuthlessProviderModel(model, this.opts.name)) {
      return postJSONWithoutAuth(client, ctx, url, payload, stream);
    }
    if (extraHeaders) {
      return postJSONWithHeaders(client, ctx, url, credentials, payload, stream, extraHeaders);
    }
    return postJSON(client, ctx, url, credentials, payload, stream);
  }

  buildPayload(body: Record<string, unknown>, model: string, modelName: string, stream: boolean): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (this.opts.supportedParams.has(key) && value !== undefined && value !== null) {
        payload[key] = value;
      }
    }
    if (providerConfigBoolHelper(this.opts.registry, model, this.opts.name, "top_p_deprecated")) {
      delete payload["top_p"];
    }
    payload["model"] = modelName;
    payload["stream"] = stream;
    return payload;
  }

  buildResponsesPayload(body: Record<string, unknown>, modelName: string, stream: boolean): Record<string, unknown> {
    const messages = body["messages"] as unknown[] | undefined;
    const payload: Record<string, unknown> = { model: modelName, stream };
    if (Array.isArray(body["_responsesInput"])) {
      payload["input"] = normalizeResponsesInput(body["_responsesInput"] as unknown[]);
    } else {
      payload["input"] = messagesToResponsesInput(messages ?? []);
    }
    const instructions = stringValue(body["instructions"]);
    if (instructions !== "") payload["instructions"] = instructions;
    if (body["temperature"] !== undefined && body["temperature"] !== null) payload["temperature"] = body["temperature"];
    if (body["top_p"] !== undefined && body["top_p"] !== null) payload["top_p"] = body["top_p"];
    if (body["max_tokens"] !== undefined && body["max_tokens"] !== null) {
      payload["max_output_tokens"] = body["max_tokens"];
    } else if (body["max_completion_tokens"] !== undefined && body["max_completion_tokens"] !== null) {
      payload["max_output_tokens"] = body["max_completion_tokens"];
    }
    const tools = convertToolsForResponses(body["tools"]);
    if (tools.length > 0) payload["tools"] = tools;
    if (body["tool_choice"] !== undefined && body["tool_choice"] !== null) payload["tool_choice"] = normalizeToolChoiceHelper(body["tool_choice"]);
    if (body["parallel_tool_calls"] !== undefined && body["parallel_tool_calls"] !== null) payload["parallel_tool_calls"] = body["parallel_tool_calls"];
    if (body["reasoning"] && typeof body["reasoning"] === "object") {
      payload["reasoning"] = cloneAnyMap(body["reasoning"] as Record<string, unknown>);
    } else if (stringValue(body["reasoning_effort"]) !== "") {
      payload["reasoning"] = { effort: stringValue(body["reasoning_effort"]) };
    }
    for (const key of ["include", "previous_response_id", "prompt_cache_key", "service_tier", "store", "text", "truncation", "user"]) {
      if (body[key] !== undefined && body[key] !== null) payload[key] = body[key];
    }
    return payload;
  }

  normalizeModel(model: string): string {
    if (this.opts.trimPrefix !== "" && model.startsWith(this.opts.trimPrefix)) {
      return model.slice(this.opts.trimPrefix.length);
    }
    return model;
  }

  resolveModel(model: string): string {
    if (this.opts.registry) {
      return this.opts.registry.upstreamModelName(model, this.opts.name);
    }
    return model;
  }

  requiresResponsesAPI(model: string): boolean {
    return providerConfigBoolHelper(this.opts.registry, model, this.opts.name, "responses_api");
  }
}

export class OpencodeProvider implements Provider {
  constructor(private registry: Registry | null) {}

  authless(): boolean {
    return true;
  }

  async makeRequest(client: HttpClient, ctx: RequestContext, _credentials: string, _account: ProviderAccountLike, body: Record<string, unknown>, stream: boolean): Promise<UpstreamResponse> {
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (supportedOpencode.has(key) && value !== undefined && value !== null) {
        payload[key] = value;
      }
    }
    let model = stringValue(body["model"]);
    if (model.startsWith("opencode/")) {
      model = model.slice("opencode/".length);
    }
    if (this.registry) {
      model = this.registry.upstreamModelName(model, "opencode");
    }
    payload["model"] = model;
    payload["stream"] = stream;
    return postJSONWithHeaders(client, ctx, opencodeChatCompletionsEndpoint, opencodePublicAPIKey, payload, stream, opencodeHeaders(body));
  }
}

function opencodeHeaders(body: Record<string, unknown>): Record<string, string> {
  let sessionID = stringValue(body["_sessionId"]);
  if (sessionID === "") sessionID = randomID("ses");
  let requestID = stringValue(body["_requestId"]);
  if (requestID === "") requestID = randomID("msg");
  let projectID = stringValue(body["_projectId"]);
  if (projectID === "") projectID = "global";
  return {
    "user-agent": opencodeUserAgent,
    "x-opencode-project": projectID,
    "x-opencode-session": sessionID,
    "x-opencode-request": requestID,
    "x-opencode-client": opencodeClient,
  };
}

export class WorkersAIProvider implements Provider {
  constructor(private registry: Registry) {}

  async makeRequest(client: HttpClient, ctx: RequestContext, credentials: string, account: ProviderAccountLike, body: Record<string, unknown>, stream: boolean): Promise<UpstreamResponse> {
    if (account.accountId === null || account.accountId.trim() === "") {
      throw new Error("missing Cloudflare Account ID on Cloudflare account");
    }
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (supportedWorkersAI.has(key) && value !== undefined && value !== null) {
        payload[key] = value;
      }
    }
    const model = stringValue(body["model"]);
    payload["model"] = this.registry.upstreamModelName(model, "workers_ai");
    payload["stream"] = stream;
    if (Array.isArray(payload["messages"])) {
      payload["messages"] = await convertImageURLsToBase64(client, ctx, payload["messages"] as unknown[]);
    }
    const url = "https://api.cloudflare.com/client/v4/accounts/" + account.accountId.trim() + "/ai/v1/chat/completions";
    return postJSON(client, ctx, url, credentials, payload, stream);
  }
}

export class ProviderRegistry {
  private providers = new Map<string, Provider>();

  constructor(registry: Registry | null) {
    this.providers.set("opencode", new OpencodeProvider(registry));
    this.providers.set("openrouter", new OpenAICompatibleProvider({ name: "openrouter", baseURL: "https://openrouter.ai/api/v1", supportedParams: supportedOpenRouter, registry, trimPrefix: "openrouter/" }));
    this.providers.set("nvidia_nim", new OpenAICompatibleProvider({ name: "nvidia_nim", baseURL: "https://integrate.api.nvidia.com/v1", supportedParams: supportedNvidia, registry, trimPrefix: "nvidia_nim/" }));
    this.providers.set("kilo_code", new OpenAICompatibleProvider({ name: "kilo_code", baseURL: "https://unroxy.koyeb.app/api.kilo.ai/api/gateway", supportedParams: supportedKilo, registry, trimPrefix: "kilo_code/" }));
    this.providers.set("zenmux", new OpenAICompatibleProvider({ name: "zenmux", baseURL: "https://zenmux.ai/api/v1", supportedParams: supportedZenmux, registry, trimPrefix: "zenmux/" }));
    this.providers.set("siliconflow", new OpenAICompatibleProvider({ name: "siliconflow", baseURL: "https://api.siliconflow.com/v1", supportedParams: supportedSiliconFlow, registry, trimPrefix: "siliconflow/" }));
    this.providers.set("workers_ai", new WorkersAIProvider(registry ?? new Proxy({} as Registry, { get: () => undefined })));
  }

  /** Providers requiring credentials/refresh are registered by the service (needs db/redis). */
  register(name: string, provider: Provider): void {
    this.providers.set(name, provider);
  }

  get(name: string): Provider | undefined {
    return this.providers.get(name);
  }

  refreshableProviderNames(): string[] {
    const names: string[] = [];
    for (const [name, provider] of this.providers) {
      if (typeof (provider as { refreshCredentials?: unknown }).refreshCredentials === "function") {
        names.push(name);
      }
    }
    return names.sort();
  }
}

function set(...values: string[]): Set<string> {
  return new Set(values);
}

function cloneAnyMap(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = cloneAnyMap(value as Record<string, unknown>);
      continue;
    }
    out[key] = value;
  }
  return out;
}

// Re-export transform generators used by OpenAICompatibleProvider
export { markUpstreamResponseStarted };
