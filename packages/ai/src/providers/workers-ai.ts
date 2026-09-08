import type { Provider, ProviderRequestOptions } from "./base.js";
import type { ModelRegistry } from "../registry/registry.js";

const supportedWorkersAIParams = new Set([
  "model",
  "messages",
  "audio",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "stream",
  "stream_options",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "function_call",
  "functions",
  "presence_penalty",
  "frequency_penalty",
  "stop",
  "seed",
  "response_format",
  "reasoning_effort",
]);

export class WorkersAIProvider implements Provider {
  public name = "workers_ai";

  constructor(private registry: ModelRegistry) {}

  async makeRequest(options: ProviderRequestOptions): Promise<Response> {
    const { account, credentials, body, stream, signal } = options;
    const accountId = account.accountId?.trim();
    if (!accountId) {
      throw new Error("missing Cloudflare Account ID on Cloudflare account");
    }

    const rawModel = String(body.model || "");
    const upstreamModel = this.registry.upstreamModelName(rawModel, "workers_ai");

    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (supportedWorkersAIParams.has(key) && value !== undefined && value !== null) {
        payload[key] = value;
      }
    }
    payload.model = upstreamModel;
    payload.stream = stream;

    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;

    return await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: stream ? "text/event-stream" : "application/json",
        Authorization: `Bearer ${credentials?.trim()}`,
      },
      body: JSON.stringify(payload),
      signal,
    });
  }
}

export default WorkersAIProvider;
