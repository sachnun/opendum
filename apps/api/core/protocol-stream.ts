import { Cause, Effect, Exit, Result, Stream } from "effect";
import { Safe } from "@opendum/api/core/helpers";
import { withHeartbeat } from "@opendum/api/core/heartbeat";
import { emptyUsage, type IrEvent, type IrUsage } from "@opendum/protocol/ir";
import {
  decodeResponse,
  encodeResponse,
  streamDecoder,
  streamEncoder,
  type Dialect,
} from "@opendum/protocol/upstream";
import { formatSse, SseReader } from "@opendum/protocol/sse";
import type { ResponseContext, StreamCompletion, StreamRecorder } from "@opendum/api/core/types";

type Json = Record<string, unknown>;

const encoder = new TextEncoder();

function sseHeaders(accountId: string): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Provider-Account-Id": accountId,
  };
}

function recordSuccess(ctx: ResponseContext, recorder: StreamRecorder, usage: IrUsage, stream: boolean): void {
  recorder.recordSuccess({
    accountId: ctx.accountId,
    provider: ctx.provider,
    model: ctx.model,
    userId: ctx.userId,
    apiKeyId: ctx.apiKeyId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedTokens: usage.cachedTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    durationMs: Date.now() - ctx.startMs,
    stream,
    requestStartMs: ctx.requestStartMs,
    firstResponseMs: ctx.firstResponseMs,
  });
}

function hyperCredits(recorder: StreamRecorder, accountId: string, provider: string, data: string): void {
  if (provider !== "hyper") return;
  const parsed = Safe.json(data);
  if (Result.isFailure(parsed)) return;
  const usage = (parsed.success as Json).usage;
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) return;
  const value = usage as Json;
  let remaining: number | null = null;
  if (value.remaining !== null && typeof value.remaining === "object" && !Array.isArray(value.remaining)) {
    const amount = Number((value.remaining as Json).hypercredits);
    if (Number.isFinite(amount) && amount > 0) remaining = amount;
  }
  let cost = 0;
  if (value.cost !== null && typeof value.cost === "object" && !Array.isArray(value.cost)) {
    const amount = Number((value.cost as Json).hypercredits);
    if (Number.isFinite(amount)) cost = amount;
  }
  if (remaining !== null || cost > 0) recorder.storeCredits(accountId, remaining, cost);
}

async function* relay(
  body: ReadableStream<Uint8Array>,
  from: Dialect,
  to: Dialect,
  model: string,
  onRaw: (data: string) => void
): AsyncGenerator<IrEvent> {
  const reader = new SseReader(body);
  const decoder = streamDecoder(from, model);
  for (;;) {
    const event = await reader.next();
    if (!event) break;
    if (event.data.trim() === "[DONE]") break;
    onRaw(event.data);
    for (const decoded of decoder.decode(event)) yield decoded;
  }
  yield decoder.finish();
}

export type ProtocolStreamOptions = {
  from: Dialect;
  to: Dialect;
  model: string;
};

export async function protocolStream(
  ctx: ResponseContext,
  recorder: StreamRecorder,
  options: ProtocolStreamOptions
): Promise<Response> {
  const body = ctx.response.body;
  if (!body) return ctx.response;
  ctx.streamHandled = true;
  let usage = emptyUsage();
  let completion: StreamCompletion = "success";
  let finalized = false;
  const codec = streamEncoder(options.to);

  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    ctx.usage.inputTokens = usage.inputTokens;
    ctx.usage.outputTokens = usage.outputTokens;
    ctx.usage.cachedTokens = usage.cachedTokens;
    ctx.usage.cacheWriteTokens = usage.cacheWriteTokens;
    if (completion === "success") recordSuccess(ctx, recorder, usage, true);
    ctx.onStreamComplete?.(completion);
  };

  async function* pipeline(): AsyncGenerator<Uint8Array> {
    const source = body as ReadableStream<Uint8Array>;
    const onRaw = (data: string): void => {
      hyperCredits(recorder, ctx.accountId, ctx.provider, data);
    };
    for await (const event of relay(source, options.from, options.to, options.model, onRaw)) {
      if (event.type === "finish") usage = event.usage;
      for (const chunk of codec.encode(event)) yield encoder.encode(formatSse(chunk));
    }
  }

  const iterator = pipeline();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await iterator.next();
      if (result.done) {
        controller.close();
        return;
      }
      controller.enqueue(result.value);
    },
    async cancel() {
      completion = "cancel";
      await iterator.return(undefined);
    },
  });

  const tracked = Stream.fromReadableStream<Uint8Array, Error>({
    evaluate: () => stream,
    onError: (error) => (error instanceof Error ? error : new Error(String(error))),
    releaseLockOnEnd: true,
  }).pipe(
    Stream.onExit((exit) =>
      Effect.sync(() => {
        if (completion === "cancel") return;
        completion = Exit.isSuccess(exit) ? "success" : Cause.hasInterruptsOnly(exit.cause) ? "cancel" : "error";
      })
    ),
    Stream.ensuring(Effect.sync(() => finalize())),
    Stream.toReadableStream()
  );

  return new Response(withHeartbeat(tracked, ctx.heartbeatMs ?? 0), {
    status: 200,
    headers: sseHeaders(ctx.accountId),
  });
}

export type ProtocolResponseOptions = {
  from: Dialect;
  to: Dialect;
  model: string;
};

export async function protocolResponse(
  ctx: ResponseContext,
  recorder: StreamRecorder,
  options: ProtocolResponseOptions
): Promise<Response> {
  const bodyText = await ctx.response.text();
  const parsed = Safe.json(bodyText);
  const payload = (Result.isSuccess(parsed) ? parsed.success : {}) as Json;
  const response = decodeResponse(options.from, payload, options.model);
  ctx.usage.inputTokens = response.usage.inputTokens;
  ctx.usage.outputTokens = response.usage.outputTokens;
  ctx.usage.cachedTokens = response.usage.cachedTokens;
  ctx.usage.cacheWriteTokens = response.usage.cacheWriteTokens;
  recordSuccess(ctx, recorder, response.usage, false);
  const encoded = encodeResponse(options.to, response);
  return new Response(JSON.stringify(encoded), {
    status: 200,
    headers: { "Content-Type": "application/json", "X-Provider-Account-Id": ctx.accountId },
  });
}


