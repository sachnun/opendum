import { numberAsInt, stringValue } from "./helpers.js";
import { SseScanner } from "./sse.js";
import { transformOpenAIToAnthropic } from "./endpoints.js";
import { OpenAIStreamUsageTracker, usageCacheCounts, usageFromJson, usageObject } from "./usage.js";
import type { ResponseContext, StreamRecorder } from "./types.js";

type Json = Record<string, unknown>;

const decoder = new TextDecoder();

export async function passthroughStream(ctx: ResponseContext, recorder: StreamRecorder): Promise<Response> {
  const body = ctx.response.body;
  if (!body) return ctx.response;
  const tracker = new OpenAIStreamUsageTracker();
  const reader = body.getReader();
  let usageRecorded = false;
  const finish = (): void => {
    if (usageRecorded) return;
    usageRecorded = true;
    tracker.flush();
    ctx.usage.inputTokens = tracker.inputTokens;
    ctx.usage.outputTokens = tracker.outputTokens;
    ctx.usage.cachedTokens = tracker.cachedTokens;
    ctx.usage.cacheWriteTokens = tracker.cacheWriteTokens;
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
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        finish();
        controller.error(new Error("upstream stream failed"));
        return;
      }
      if (result.done) {
        finish();
        controller.close();
        return;
      }
      tracker.process(decoder.decode(result.value, { stream: true }));
      controller.enqueue(result.value);
    },
    async cancel() {
      finish();
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
  let parsed: Json = {};
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
  let openAi: Json = {};
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

class AnthropicStreamTracker {
  private readonly scanner = new SseScanner();
  private openBlockType = "";
  private blockIndex = 0;
  private thinkingBlock = 0;
  private hasThinkingBlock = false;
  private thinkingBlockOpen = false;
  private pendingText = "";
  private toolBlockById = new Map<string, number>();
  private toolBlockByIndex = new Map<number, { index: number; id: string }>();
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
    let parsed: Json;
    try {
      parsed = JSON.parse(data) as Json;
    } catch {
      return;
    }
    const usage = usageObject(parsed);
    if (usage) {
      let input = numberAsInt(usage.prompt_tokens);
      if (input === 0) input = numberAsInt(usage.input_tokens);
      if (input > 0) this.inputTokens = input;
      let output = numberAsInt(usage.completion_tokens);
      if (output === 0) output = numberAsInt(usage.output_tokens);
      if (output > 0) this.outputTokens = output;
      const { cached, write } = usageCacheCounts(usage);
      if (cached > 0) this.cachedTokens = cached;
      if (write > 0) this.cacheWriteTokens = write;
    }
    const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
    if (choices.length === 0) return;
    const choice = (choices[0] ?? {}) as Json;
    const delta = (choice.delta ?? {}) as Json;
    const reasoning = stringValue(delta.reasoning_content);
    if (reasoning) this.writeThinkingDelta(reasoning);
    const text = stringValue(delta.content);
    if (text) this.writeTextDelta(text);
    if (Array.isArray(delta.tool_calls)) {
      for (const raw of delta.tool_calls) this.writeToolCallDelta(raw);
    }
    const finish = stringValue(choice.finish_reason);
    if (finish) {
      this.closeThinkingBlock();
      this.flushPendingText();
      this.finishReason = mapFinishReason(finish);
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
      this.closeOpenToolBlocks();
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
        this.closeOpenToolBlocks();
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
        this.closeOpenToolBlocks();
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
      this.closeOpenToolBlocks();
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

  private writeToolCallDelta(raw: unknown): void {
    this.closeThinkingBlock();
    this.flushPendingText();
    const call = (raw ?? {}) as Json;
    const fn = (call.function ?? {}) as Json;
    const openAiIndex = numberAsInt(call.index);
    let id = stringValue(call.id) || stringValue(call.call_id);
    if (!id) id = this.toolBlockByIndex.get(openAiIndex)?.id ?? "";
    if (!id) id = `toolu_${Date.now()}_${openAiIndex}`;
    const index = this.ensureToolBlock(openAiIndex, id, stringValue(fn.name));
    const args = stringValue(fn.arguments);
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
    const existing = this.toolBlockById.get(id);
    if (existing !== undefined) return existing;
    const index = this.blockIndex;
    this.blockIndex += 1;
    this.toolBlockById.set(id, index);
    this.toolBlockByIndex.set(openAiIndex, { index, id });
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

  private closeOpenToolBlocks(): void {
    if (this.openToolBlocks.size === 0) return;
    const indexes = [...this.openToolBlocks].sort((a, b) => a - b);
    for (const index of indexes) {
      this.write("content_block_stop", { type: "content_block_stop", index });
      this.openToolBlocks.delete(index);
    }
  }

  finish(): void {
    this.scanner.flush((event) => this.processEvent(event.data));
    this.closeThinkingBlock();
    this.flushPendingText();
    this.closeOpenBlock();
    this.closeOpenToolBlocks();
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
}

function mapFinishReason(reason: string): string {
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
  const encoder = new TextEncoder();
  const reader = body.getReader();
  const tracker = new AnthropicStreamTracker(
    (event, data) => {
      controller?.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    },
    ctx.model,
    ctx.provider === "kiro"
  );
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let finished = false;

  const finish = (): void => {
    if (finished) return;
    finished = true;
    tracker.finish();
    ctx.usage.inputTokens = tracker.inputTokens;
    ctx.usage.outputTokens = tracker.outputTokens;
    ctx.usage.cachedTokens = tracker.cachedTokens;
    ctx.usage.cacheWriteTokens = tracker.cacheWriteTokens;
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
        finish();
        nextController.error(new Error("upstream stream failed"));
        return;
      }
      if (result.done) {
        finish();
        nextController.close();
        return;
      }
      controller = nextController;
      tracker.process(decoder.decode(result.value, { stream: true }));
    },
    async cancel() {
      finish();
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
