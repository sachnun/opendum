import { Cause, Effect, Exit, Result, Stream } from "effect";
import { Coerce, Safe } from "@opendum/api/core/helpers";
import { withHeartbeat } from "@opendum/api/core/heartbeat";
import { SseScanner } from "@opendum/api/core/sse";
import { transformOpenAIToAnthropic } from "@opendum/api/core/endpoints";
import { StreamUsageTracker, cacheCounts, usageOf, usageObject } from "@opendum/api/core/usage";
import type { ResponseContext, StreamCompletion, StreamRecorder } from "@opendum/api/core/types";

type Json = Record<string, unknown>;

const decoder = new TextDecoder();
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

export async function nonStream(ctx: ResponseContext, recorder: StreamRecorder): Promise<Response> {
  const bodyText = await ctx.response.text();
  const parsedBody = Safe.json(bodyText);
  const openAi = (Result.isSuccess(parsedBody) ? parsedBody.success : {}) as Json;
  const response = transformOpenAIToAnthropic(openAi, ctx.model);
  const counts = usageOf(openAi);
  ctx.usage.inputTokens = counts.inputTokens;
  ctx.usage.outputTokens = counts.outputTokens;
  ctx.usage.cachedTokens = counts.cachedTokens;
  ctx.usage.cacheWriteTokens = counts.cacheWriteTokens;
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
  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { "Content-Type": "application/json", "X-Provider-Account-Id": ctx.accountId },
  });
}

class AnthropicStreamTracker {
  private readonly scanner = new SseScanner();
  private openBlockType = "";
  private blockIndex = 0;
  private thinkingBlock = 0;
  private hasThinkingBlock = false;
  private thinkingBlockOpen = false;
  private pendingText = "";
  private blockById = new Map<string, number>();
  private blockByIndex = new Map<number, { index: number; id: string }>();
  private openToolBlocks = new Set<number>();
  inputTokens = 0;
  outputTokens = 0;
  cachedTokens = 0;
  cacheWriteTokens = 0;
  private finishReason = "";

  constructor(
    private readonly write: (event: string, data: Json) => void,
    private readonly model: string,
    private readonly keepThinkingOpen: boolean
  ) {}

  process(chunk: string): void {
    this.scanner.process(chunk, (event) => this.processEvent(event.data));
  }

  private processEvent(data: string): void {
    const parsedData = Safe.json(data);
    if (Result.isFailure(parsedData)) return;
    const parsed = parsedData.success as Json;
    const usage = usageObject(parsed);
    if (usage) {
      let input = Coerce.int(usage.prompt_tokens);
      if (input === 0) input = Coerce.int(usage.input_tokens);
      if (input > 0) this.inputTokens = input;
      let output = Coerce.int(usage.completion_tokens);
      if (output === 0) output = Coerce.int(usage.output_tokens);
      if (output > 0) this.outputTokens = output;
      const { cached, write } = cacheCounts(usage);
      if (cached > 0) this.cachedTokens = cached;
      if (write > 0) this.cacheWriteTokens = write;
    }
    const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
    if (choices.length === 0) return;
    const choice = (choices[0] ?? {}) as Json;
    const delta = (choice.delta ?? {}) as Json;
    const reasoning = Coerce.string(delta.reasoning_content);
    if (reasoning) this.writeThinkingDelta(reasoning);
    const text = Coerce.string(delta.content);
    if (text) this.writeTextDelta(text);
    if (Array.isArray(delta.tool_calls)) {
      for (const raw of delta.tool_calls) this.writeToolDelta(raw);
    }
    const finish = Coerce.string(choice.finish_reason);
    if (finish) {
      this.closeThinkingBlock();
      this.flushPendingText();
      this.finishReason = finishReason(finish);
    }
  }

  private writeTextDelta(text: string): void {
    if (this.keepThinkingOpen && this.thinkingBlockOpen) {
      if (this.pendingText) {
        this.closeThinkingBlock();
        this.flushPendingText();
      } else {
        this.pendingText += text;
        return;
      }
    }
    if (this.openBlockType !== "text") {
      this.closeToolBlocks();
      this.closeOpenBlock();
      this.write("content_block_start", {
        type: "content_block_start",
        index: this.blockIndex,
        content_block: { type: "text", text: "" },
      });
      this.openBlockType = "text";
    }
    this.write("content_block_delta", {
      type: "content_block_delta",
      index: this.blockIndex,
      delta: { type: "text_delta", text },
    });
  }

  private writeThinkingDelta(thinking: string): void {
    if (!this.keepThinkingOpen) {
      if (this.openBlockType !== "thinking") {
        this.closeToolBlocks();
        this.closeOpenBlock();
        this.write("content_block_start", {
          type: "content_block_start",
          index: this.blockIndex,
          content_block: { type: "thinking", thinking: "" },
        });
        this.openBlockType = "thinking";
      }
      this.write("content_block_delta", {
        type: "content_block_delta",
        index: this.blockIndex,
        delta: { type: "thinking_delta", thinking },
      });
      return;
    }
    if (this.hasThinkingBlock && !this.thinkingBlockOpen) {
      if (this.openBlockType !== "thinking") {
        this.closeToolBlocks();
        this.closeOpenBlock();
        this.write("content_block_start", {
          type: "content_block_start",
          index: this.blockIndex,
          content_block: { type: "thinking", thinking: "" },
        });
        this.openBlockType = "thinking";
      }
      this.write("content_block_delta", {
        type: "content_block_delta",
        index: this.blockIndex,
        delta: { type: "thinking_delta", thinking },
      });
      return;
    }
    if (!this.hasThinkingBlock) {
      this.closeToolBlocks();
      this.closeOpenBlock();
      this.thinkingBlock = this.blockIndex;
      this.hasThinkingBlock = true;
      this.thinkingBlockOpen = true;
      this.write("content_block_start", {
        type: "content_block_start",
        index: this.blockIndex,
        content_block: { type: "thinking", thinking: "" },
      });
      this.blockIndex += 1;
      this.openBlockType = "thinking";
    }
    this.write("content_block_delta", {
      type: "content_block_delta",
      index: this.thinkingBlock,
      delta: { type: "thinking_delta", thinking },
    });
  }

  private writeToolDelta(raw: unknown): void {
    this.closeThinkingBlock();
    this.flushPendingText();
    const call = (raw ?? {}) as Json;
    const fn = (call.function ?? {}) as Json;
    const openAiIndex = Coerce.int(call.index);
    let id = Coerce.string(call.id) || Coerce.string(call.call_id);
    if (!id) id = this.blockByIndex.get(openAiIndex)?.id ?? "";
    if (!id) id = `toolu_${Date.now()}_${openAiIndex}`;
    const index = this.ensureToolBlock(openAiIndex, id, Coerce.string(fn.name));
    const args = Coerce.string(fn.arguments);
    if (args) {
      this.write("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: args },
      });
    }
  }

  private ensureToolBlock(openAiIndex: number, id: string, name: string): number {
    this.closeOpenBlock();
    const existing = this.blockById.get(id);
    if (existing !== undefined) return existing;
    const index = this.blockIndex;
    this.blockIndex += 1;
    this.blockById.set(id, index);
    this.blockByIndex.set(openAiIndex, { index, id });
    this.openToolBlocks.add(index);
    this.write("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id, name, input: {} },
    });
    return index;
  }

  private closeOpenBlock(): void {
    if (!this.openBlockType) return;
    if (this.keepThinkingOpen && this.thinkingBlockOpen && this.openBlockType === "thinking") {
      this.openBlockType = "";
      return;
    }
    this.write("content_block_stop", { type: "content_block_stop", index: this.blockIndex });
    this.blockIndex += 1;
    this.openBlockType = "";
  }

  private closeThinkingBlock(): void {
    if (!this.keepThinkingOpen || !this.hasThinkingBlock || !this.thinkingBlockOpen) return;
    this.write("content_block_stop", { type: "content_block_stop", index: this.thinkingBlock });
    this.thinkingBlockOpen = false;
    if (this.openBlockType === "thinking") this.openBlockType = "";
  }

  private flushPendingText(): void {
    if (!this.pendingText) return;
    const text = this.pendingText;
    this.pendingText = "";
    this.writeTextDelta(text);
  }

  private closeToolBlocks(): void {
    if (this.openToolBlocks.size === 0) return;
    const indexes = [...this.openToolBlocks].sort((a, b) => a - b);
    for (const index of indexes) {
      this.write("content_block_stop", { type: "content_block_stop", index });
      this.openToolBlocks.delete(index);
    }
  }

  finish(): void {
    this.scannerFlush();
    this.closeThinkingBlock();
    this.flushPendingText();
    this.closeOpenBlock();
    this.closeToolBlocks();
    const stopReason = this.finishReason || "end_turn";
    const deltaUsage: Json = { input_tokens: this.inputTokens, output_tokens: this.outputTokens };
    if (this.cachedTokens > 0) deltaUsage.cache_read_input_tokens = this.cachedTokens;
    if (this.cacheWriteTokens > 0) deltaUsage.cache_creation_input_tokens = this.cacheWriteTokens;
    this.write("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: deltaUsage,
    });
    this.write("message_stop", { type: "message_stop" });
  }

  scannerFlush(): void {
    this.scanner.flush((event) => this.processEvent(event.data));
  }
}

function finishReason(reason: string): string {
  switch (reason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    default:
      return "end_turn";
  }
}

export async function anthropicStream(ctx: ResponseContext, recorder: StreamRecorder): Promise<Response> {
  const body = ctx.response.body;
  if (!body) return ctx.response;
  const messageId = `msg_${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
  ctx.streamHandled = true;

  const encoderChunk = (event: string, data: Json): Uint8Array =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const start = encoder.encode(
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
  );

  let completion: StreamCompletion = "success";
  let finalized = false;
  let started = false;
  let closing = false;
  const pending: Uint8Array[] = [];
  const tracker = new AnthropicStreamTracker(
    (event, data) => {
      pending.push(encoderChunk(event, data));
    },
    ctx.model,
    ctx.provider === "kiro"
  );

  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    ctx.usage.inputTokens = tracker.inputTokens;
    ctx.usage.outputTokens = tracker.outputTokens;
    ctx.usage.cachedTokens = tracker.cachedTokens;
    ctx.usage.cacheWriteTokens = tracker.cacheWriteTokens;
    if (completion === "success") {
      tracker.finish();
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

  const takePending = (): Uint8Array => {
    const parts: Uint8Array[] = [];
    if (!started) {
      started = true;
      parts.push(start);
    }
    parts.push(...pending);
    pending.length = 0;
    return joinBytes(parts);
  };

  const stream = readableChunks(body).pipe(
    Stream.map((chunk) => {
      tracker.process(decoder.decode(chunk, { stream: true }));
      return takePending();
    }),
    Stream.onExit((exit) =>
      Effect.sync(() => {
        completion = Exit.isSuccess(exit) ? "success" : Cause.hasInterruptsOnly(exit.cause) ? "cancel" : "error";
      })
    ),
    Stream.concat(
      Stream.fromEffect(
        Effect.sync(() => {
          if (!closing) {
            closing = true;
            finalize();
          }
          return takePending();
        })
      )
    ),
    Stream.ensuring(
      Effect.sync(() => {
        finalize();
      })
    ),
    Stream.toReadableStream()
  );

  return new Response(withHeartbeat(stream, ctx.heartbeatMs ?? 0), { status: 200, headers: sseHeaders(ctx.accountId) });
}

function joinBytes(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0] as Uint8Array;
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
