import { Effect } from "effect";
import type { Registry } from "@opendum/models/runtime";
import { Value } from "@opendum/providers/core/helpers";
import { ChatImageInliner } from "@opendum/providers/core/images";
import { JSONPoster, RequestFailure, type UpstreamTransport } from "@opendum/providers/core/http";
import type { Provider, ProviderFailure, ProviderRequest } from "@opendum/providers/types";

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

  makeRequest(request: ProviderRequest): Effect.Effect<Response, ProviderFailure> {
    const accountId = request.account.accountId;
    if (!accountId || !accountId.trim()) {
      return Effect.fail(
        RequestFailure.transport("workers_ai", new Error("missing Cloudflare Account ID on Cloudflare account"))
      );
    }
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(request.body)) {
      if (SUPPORTED_WORKERS_AI.has(key) && value !== undefined && value !== null) payload[key] = value;
    }
    const model = Value.string(request.body.model);
    payload.model = this.registry.upstream(model, "workers_ai");
    payload.stream = request.stream;
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId.trim()}/ai/v1/chat/completions`;
    const direct = this.transport.direct;
    return Effect.gen(function* () {
      if (Array.isArray(payload.messages)) {
        payload.messages = yield* Effect.tryPromise({
          try: () => new ChatImageInliner(direct).run(payload.messages as unknown[]),
          catch: (cause) => RequestFailure.transport("workers_ai", cause, url),
        });
      }
      return yield* JSONPoster.withAuth({
        provider: "workers_ai",
        fetchFn: direct,
        url,
        bearer: request.credentials,
        payload,
        stream: request.stream,
        onStart: request.onResponseStart,
      });
    });
  }
}
