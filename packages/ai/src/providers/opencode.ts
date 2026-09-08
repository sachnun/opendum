import type { Provider, ProviderRequestOptions } from "./base.js";
import type { ModelRegistry } from "../registry/registry.js";

const OPENCODE_CHAT_COMPLETIONS_ENDPOINT = "https://unroxy.koyeb.app/opencode.ai/zen/v1/chat/completions";
const OPENCODE_RESPONSES_ENDPOINT = "https://unroxy.koyeb.app/opencode.ai/zen/v1/responses";
const OPENCODE_PUBLIC_API_KEY = "public";
const OPENCODE_CLIENT = "cli";
const OPENCODE_USER_AGENT = "opencode/1.15.8";

const supportedOpencodeParams = new Set([
  "model",
  "messages",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "stream",
  "stream_options",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "presence_penalty",
  "frequency_penalty",
  "n",
  "stop",
  "seed",
  "response_format",
  "reasoning",
  "reasoning_effort",
]);

export class OpencodeProvider implements Provider {
  public name = "opencode";

  constructor(private registry: ModelRegistry) {}

  isAuthless(): boolean {
    return true;
  }

  async makeRequest(options: ProviderRequestOptions): Promise<Response> {
    const { body, stream, signal } = options;
    const rawModel = String(body.model || "");
    const model = rawModel.startsWith("opencode/")
      ? rawModel.slice("opencode/".length)
      : rawModel;
    const upstreamModel = this.registry.upstreamModelName(model, "opencode");

    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (supportedOpencodeParams.has(key) && value !== undefined && value !== null) {
        payload[key] = value;
      }
    }
    payload.model = upstreamModel;
    payload.stream = stream;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
      Authorization: `Bearer ${OPENCODE_PUBLIC_API_KEY}`,
      "User-Agent": OPENCODE_USER_AGENT,
      "X-Opencode-Client": OPENCODE_CLIENT,
      "X-Opencode-Project": String(body._projectId || "global"),
      "X-Opencode-Session": String(body._sessionId || `ses_${Math.random().toString(36).slice(2)}`),
      "X-Opencode-Request": String(body._requestId || `msg_${Math.random().toString(36).slice(2)}`),
    };

    const isResponses = this.registry.providerConfigBool(model, "opencode", "responses_api");
    const endpoint = isResponses
      ? OPENCODE_RESPONSES_ENDPOINT
      : OPENCODE_CHAT_COMPLETIONS_ENDPOINT;

    return await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal,
    });
  }
}
