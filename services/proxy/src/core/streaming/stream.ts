import { AnthropicStreamTracker } from "./anthropic-stream.ts";
import { transformOpenAIToAnthropic } from "./anthropic-format.ts";
import { OpenAIStreamUsageTracker, usageFromJson } from "../metering/usage.ts";
import type { ResponseContext, StreamCompletion, StreamRecorder } from "../types.ts";

type Json = Record<string, unknown>;

const decoder = new TextDecoder();

export async function passthroughStream(ctx: ResponseContext, recorder: StreamRecorder): Promise<Response> {
  const body = ctx.response.body;
  if (!body) return ctx.response;
  const tracker = new OpenAIStreamUsageTracker();
  const reader = body.getReader();
  ctx.streamHandled = true;
  let settled = false;
  const finish = (reason: StreamCompletion): void => {
    if (settled) return;
    settled = true;
    tracker.flush();
    ctx.usage.inputTokens = tracker.inputTokens;
    ctx.usage.outputTokens = tracker.outputTokens;
    ctx.usage.cachedTokens = tracker.cachedTokens;
    ctx.usage.cacheWriteTokens = tracker.cacheWriteTokens;
    if (reason === "success") {
      if (ctx.provider === "hyper" && (tracker.hypercreditsRemaining !== null || tracker.hypercreditsCost > 0)) {
        recorder.storeHypercreditsUsage(ctx.accountId, tracker.hypercreditsRemaining, tracker.hypercreditsCost);
      }
      recorder.recordSuccessfulRequest({
        accountId: ctx.accountId,
        provider: ctx.provider,
        model: ctx.model,
        userId: ctx.userId,
        apiKeyId: ctx.apiKeyId,
        inputTokens: tracker.inputTokens,
        outputTokens: tracker.outputTokens,
        cachedTokens: tracker.cachedTokens,
        cacheWriteTokens: tracker.cacheWriteTokens,
        durationMs: Date.now() - ctx.startMs,
        stream: true,
        requestStartMs: ctx.requestStartMs,
        upstreamFirstResponseMs: ctx.upstreamFirstResponseMs,
      });
    }
    ctx.onStreamComplete?.(reason);
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        finish("error");
        controller.error(new Error("upstream stream failed"));
        return;
      }
      if (result.done) {
        finish("success");
        controller.close();
        return;
      }
      tracker.process(decoder.decode(result.value, { stream: true }));
      controller.enqueue(result.value);
    },
    async cancel() {
      finish("cancel");
      try {
        await reader.cancel();
      } catch {
        return;
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Provider-Account-Id": ctx.accountId,
    },
  });
}

export async function passthroughNonStream(ctx: ResponseContext, recorder: StreamRecorder): Promise<Response> {
  const bodyText = await ctx.response.text();
  let parsed: Json;
  try {
    parsed = JSON.parse(bodyText) as Json;
  } catch {
    parsed = {};
  }
  const counts = usageFromJson(parsed);
  ctx.usage.inputTokens = counts.inputTokens;
  ctx.usage.outputTokens = counts.outputTokens;
  ctx.usage.cachedTokens = counts.cachedTokens;
  ctx.usage.cacheWriteTokens = counts.cacheWriteTokens;
  if (ctx.provider === "hyper") {
    const usage = parsed.usage;
    if (usage !== null && typeof usage === "object" && !Array.isArray(usage)) {
      const u = usage as Json;
      let remaining: number | null = null;
      if (u.remaining !== null && typeof u.remaining === "object" && !Array.isArray(u.remaining)) {
        const value = Number((u.remaining as Json).hypercredits);
        if (Number.isFinite(value) && value > 0) remaining = value;
      }
      let cost = 0;
      if (u.cost !== null && typeof u.cost === "object" && !Array.isArray(u.cost)) {
        const value = Number((u.cost as Json).hypercredits);
        if (Number.isFinite(value)) cost = value;
      }
      if (remaining !== null || cost > 0) recorder.storeHypercreditsUsage(ctx.accountId, remaining, cost);
    }
  }
  recorder.recordSuccessfulRequest({
    accountId: ctx.accountId,
    provider: ctx.provider,
    model: ctx.model,
    userId: ctx.userId,
    apiKeyId: ctx.apiKeyId,
    inputTokens: counts.inputTokens,
    outputTokens: counts.outputTokens,
    cachedTokens: counts.cachedTokens,
    cacheWriteTokens: counts.cacheWriteTokens,
    durationMs: Date.now() - ctx.startMs,
    stream: false,
    requestStartMs: ctx.requestStartMs,
    upstreamFirstResponseMs: ctx.upstreamFirstResponseMs,
  });
  return new Response(bodyText, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "X-Provider-Account-Id": ctx.accountId,
    },
  });
}

export async function anthropicNonStream(ctx: ResponseContext, recorder: StreamRecorder): Promise<Response> {
  const bodyText = await ctx.response.text();
  let openAi: Json;
  try {
    openAi = JSON.parse(bodyText) as Json;
  } catch {
    openAi = {};
  }
  const response = transformOpenAIToAnthropic(openAi, ctx.model);
  const counts = usageFromJson(openAi);
  ctx.usage.inputTokens = counts.inputTokens;
  ctx.usage.outputTokens = counts.outputTokens;
  ctx.usage.cachedTokens = counts.cachedTokens;
  ctx.usage.cacheWriteTokens = counts.cacheWriteTokens;
  recorder.recordSuccessfulRequest({
    accountId: ctx.accountId,
    provider: ctx.provider,
    model: ctx.model,
    userId: ctx.userId,
    apiKeyId: ctx.apiKeyId,
    inputTokens: counts.inputTokens,
    outputTokens: counts.outputTokens,
    cachedTokens: counts.cachedTokens,
    cacheWriteTokens: counts.cacheWriteTokens,
    durationMs: Date.now() - ctx.startMs,
    stream: false,
    requestStartMs: ctx.requestStartMs,
    upstreamFirstResponseMs: ctx.upstreamFirstResponseMs,
  });
  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { "Content-Type": "application/json", "X-Provider-Account-Id": ctx.accountId },
  });
}

export async function anthropicStream(ctx: ResponseContext, recorder: StreamRecorder): Promise<Response> {
  const body = ctx.response.body;
  if (!body) return ctx.response;
  const messageId = `msg_${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
  const encoder = new TextEncoder();
  const reader = body.getReader();
  ctx.streamHandled = true;
  const tracker = new AnthropicStreamTracker(
    (event, data) => {
      if (!controller) return;
      try {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      } catch {
        return;
      }
    },
    ctx.model,
    ctx.provider === "kiro"
  );
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let settled = false;

  const finish = (reason: StreamCompletion): void => {
    if (settled) return;
    settled = true;
    if (reason === "success") tracker.finish();
    ctx.usage.inputTokens = tracker.inputTokens;
    ctx.usage.outputTokens = tracker.outputTokens;
    ctx.usage.cachedTokens = tracker.cachedTokens;
    ctx.usage.cacheWriteTokens = tracker.cacheWriteTokens;
    if (reason === "success") {
      recorder.recordSuccessfulRequest({
        accountId: ctx.accountId,
        provider: ctx.provider,
        model: ctx.model,
        userId: ctx.userId,
        apiKeyId: ctx.apiKeyId,
        inputTokens: tracker.inputTokens,
        outputTokens: tracker.outputTokens,
        cachedTokens: tracker.cachedTokens,
        cacheWriteTokens: tracker.cacheWriteTokens,
        durationMs: Date.now() - ctx.startMs,
        stream: true,
        requestStartMs: ctx.requestStartMs,
        upstreamFirstResponseMs: ctx.upstreamFirstResponseMs,
      });
    }
    ctx.onStreamComplete?.(reason);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController;
      controller.enqueue(
        encoder.encode(
          `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: {
              id: messageId,
              type: "message",
              role: "assistant",
              content: [],
              model: ctx.model,
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          })}\n\n`
        )
      );
    },
    async pull(nextController) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        finish("error");
        nextController.error(new Error("upstream stream failed"));
        return;
      }
      if (result.done) {
        finish("success");
        nextController.close();
        return;
      }
      controller = nextController;
      tracker.process(decoder.decode(result.value, { stream: true }));
    },
    async cancel() {
      finish("cancel");
      try {
        await reader.cancel();
      } catch {
        return;
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Provider-Account-Id": ctx.accountId,
    },
  });
}
