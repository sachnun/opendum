import type { Registry } from "@opendum/models/runtime";
import { stringValue } from "./helpers.js";
import { convertImageURLsToBase64 } from "./images.js";
import { postJSON, type UpstreamTransport } from "./http.js";
import type { Provider, ProviderRequest } from "./types.js";

export const SUPPORTED_WORKERS_AI = new Set([
  "model", "messages", "audio", "temperature", "top_p", "max_tokens", "max_completion_tokens",
  "stream", "stream_options", "tools", "tool_choice", "parallel_tool_calls", "function_call",
  "functions", "presence_penalty", "frequency_penalty", "stop", "seed", "response_format",
  "reasoning_effort", "chat_template_kwargs", "modalities", "metadata", "prediction", "logit_bias",
  "logprobs", "top_logprobs", "store", "service_tier", "user", "web_search_options", "n",
]);

export type WorkersAiOptions = {
  registry: Registry;
  transport: UpstreamTransport;
};

export class WorkersAiProvider implements Provider {
  readonly name = "workers_ai";
  private readonly registry: Registry;
  private readonly transport: UpstreamTransport;

  constructor(options: WorkersAiOptions) {
    this.registry = options.registry;
    this.transport = options.transport;
  }

  async makeRequest(request: ProviderRequest): Promise<Response> {
    const accountId = request.account.accountId;
    if (!accountId || !accountId.trim()) {
      throw new Error("missing Cloudflare Account ID on Cloudflare account");
    }
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(request.body)) {
      if (SUPPORTED_WORKERS_AI.has(key) && value !== undefined && value !== null) payload[key] = value;
    }
    const model = stringValue(request.body.model);
    payload.model = this.registry.upstreamModelName(model, "workers_ai");
    payload.stream = request.stream;
    if (Array.isArray(payload.messages)) {
      payload.messages = await convertImageURLsToBase64(this.transport.direct, payload.messages);
    }
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId.trim()}/ai/v1/chat/completions`;
    return postJSON(
      this.transport.direct,
      url,
      request.credentials,
      payload,
      request.stream,
      request.onUpstreamResponseStart
    );
  }
}
