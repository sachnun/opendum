import { Effect } from "effect";
import { Value } from "@opendum/providers/core/helpers";
import { ChatImageInliner } from "@opendum/providers/core/images";
import { JSONPoster, RequestFailure } from "@opendum/providers/core/http";
import { StaticProvider, type Json } from "@opendum/providers/core/provider";
import type { ProviderFailure, ProviderRequest } from "@opendum/providers/types";

export const SUPPORTED_WORKERS_AI = new Set([
  "model", "messages", "audio", "temperature", "top_p", "max_tokens", "max_completion_tokens",
  "stream", "stream_options", "tools", "tool_choice", "parallel_tool_calls", "function_call",
  "functions", "presence_penalty", "frequency_penalty", "stop", "seed", "response_format",
  "reasoning_effort", "chat_template_kwargs", "modalities", "metadata", "prediction", "logit_bias",
  "logprobs", "top_logprobs", "store", "service_tier", "user", "web_search_options", "n",
]);

export class WorkersAiProvider extends StaticProvider {
  readonly name = "workers_ai";

  makeRequest(request: ProviderRequest): Effect.Effect<Response, ProviderFailure> {
    const accountId = request.account.accountId;
    if (!accountId || !accountId.trim()) {
      return Effect.fail(
        RequestFailure.transport("workers_ai", new Error("missing Cloudflare Account ID on Cloudflare account"))
      );
    }
    const payload: Json = this.filterParams(request.body, SUPPORTED_WORKERS_AI);
    payload.model = this.upstream(Value.string(request.body.model));
    payload.stream = request.stream;
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId.trim()}/ai/v1/chat/completions`;
    const direct = this.transport.direct;
    return Effect.gen(function* () {
      if (Array.isArray(payload.messages)) {
        payload.messages = yield* new ChatImageInliner(direct).run(payload.messages as unknown[]);
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
