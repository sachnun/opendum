import { Cause, Effect, Exit, Result, Stream } from "effect";
import { Safe } from "@opendum/api/core/helpers";
import { withHeartbeat } from "@opendum/api/core/heartbeat";
import { StreamUsageTracker, usageOf } from "@opendum/api/core/usage";
import type { ResponseContext, StreamCompletion, StreamRecorder } from "@opendum/api/core/types";

type Json = Record<string, unknown>;

const decoder = new TextDecoder();

function sseHeaders(accountId: string): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Provider-Account-Id": accountId,
  };
}

function readableChunks(body: ReadableStream<Uint8Array>): Stream.Stream<Uint8Array, Error> {
  return Stream.fromReadableStream<Uint8Array, Error>({
    evaluate: () => body,
    onError: (error) => (error instanceof Error ? error : new Error(String(error))),
    releaseLockOnEnd: true,
  });
}

export async function passthroughStream(ctx: ResponseContext, recorder: StreamRecorder): Promise<Response> {
  const body = ctx.response.body;
  if (!body) return ctx.response;
  const tracker = new StreamUsageTracker();
  ctx.streamHandled = true;

  let completion: StreamCompletion = "success";
  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    ctx.usage.inputTokens = tracker.inputTokens;
    ctx.usage.outputTokens = tracker.outputTokens;
    ctx.usage.cachedTokens = tracker.cachedTokens;
    ctx.usage.cacheWriteTokens = tracker.cacheWriteTokens;
    if (completion === "success") {
      if (ctx.provider === "hyper" && (tracker.hypercreditsRemaining !== null || tracker.hypercreditsCost > 0)) {
        recorder.storeCredits(ctx.accountId, tracker.hypercreditsRemaining, tracker.hypercreditsCost);
      }
      recorder.recordSuccess({
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
        firstResponseMs: ctx.firstResponseMs,
      });
    }
    ctx.onStreamComplete?.(completion);
  };

  const stream = readableChunks(body).pipe(
    Stream.map((chunk) => {
      tracker.process(decoder.decode(chunk, { stream: true }));
      return chunk;
    }),
    Stream.onExit((exit) =>
      Effect.sync(() => {
        completion = Exit.isSuccess(exit) ? "success" : Cause.hasInterruptsOnly(exit.cause) ? "cancel" : "error";
      })
    ),
    Stream.ensuring(
      Effect.sync(() => {
        tracker.flush();
        finalize();
      })
    ),
    Stream.toReadableStream()
  );

  return new Response(withHeartbeat(stream, ctx.heartbeatMs ?? 0), { status: 200, headers: sseHeaders(ctx.accountId) });
}

export async function passthrough(ctx: ResponseContext, recorder: StreamRecorder): Promise<Response> {
  const bodyText = await ctx.response.text();
  const parsedBody = Safe.json(bodyText);
  const parsed = (Result.isSuccess(parsedBody) ? parsedBody.success : {}) as Json;
  const counts = usageOf(parsed);
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
      if (remaining !== null || cost > 0) recorder.storeCredits(ctx.accountId, remaining, cost);
    }
  }
  recorder.recordSuccess({
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
    firstResponseMs: ctx.firstResponseMs,
  });
  return new Response(bodyText, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "X-Provider-Account-Id": ctx.accountId,
    },
  });
}
