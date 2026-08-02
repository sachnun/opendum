import type { ResponseContext } from "../types.js";
import { SSEScanner } from "../../providers/model_helpers.js";
import { stringValue, readAllText } from "../../providers/http.js";
import { numberAsInt } from "../stream.js";
import { transformOpenAIToAnthropic } from "./transform.js";
import { usageFromJSON } from "../stream.js";
import { contentToTextLocal } from "./transform.js";

export interface AnthropicCallbacks {
  recordSuccess: (params: { inputTokens: number; outputTokens: number; durationMS: number }) => void;
}

export async function anthropicNonStream(ctx: ResponseContext, callbacks: AnthropicCallbacks): Promise<void> {
  const text = await readAllText(ctx.response.body);
  let openAI: Record<string, unknown> = {};
  try {
    openAI = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // keep empty
  }
  const response = transformOpenAIToAnthropic(openAI, ctx.model);
  const [inputTokens, outputTokens] = usageFromJSON(openAI);
  ctx.writer.header("content-type", "application/json");
  ctx.writer.header("x-provider-account-id", ctx.accountId);
  await ctx.writer.write(JSON.stringify(response));
  const durationMS = Date.now() - ctx.startMS;
  callbacks.recordSuccess({ inputTokens, outputTokens, durationMS });
}

export async function anthropicStream(ctx: ResponseContext, callbacks: AnthropicCallbacks): Promise<void> {
  const writer = ctx.writer;
  writer.header("content-type", "text/event-stream");
  writer.header("cache-control", "no-cache");
  writer.header("connection", "keep-alive");
  writer.header("x-accel-buffering", "no");
  writer.header("x-provider-account-id", ctx.accountId);

  const messageID = "msg_" + timestampCompact();
  writeAnthropicEvent(writer, "message_start", { type: "message_start", message: { id: messageID, type: "message", role: "assistant", content: [], model: ctx.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });

  const tracker = new AnthropicStreamTracker(writer, ctx.provider === "kiro");
  const reader = ctx.response.body?.getReader();
  if (reader) {
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        tracker.process(decoder.decode(value, { stream: true }));
      }
    }
  }
  tracker.finish();
  const durationMS = Date.now() - ctx.startMS;
  callbacks.recordSuccess({ inputTokens: tracker.inputTokens, outputTokens: tracker.outputTokens, durationMS });
}

interface AnthropicToolBlock {
  index: number;
  id: string;
}

class AnthropicStreamTracker {
  private scanner = new SSEScanner();
  private openBlockType = "";
  private blockIndex = 0;
  private keepThinkingOpen: boolean;
  private thinkingBlock = 0;
  private hasThinkingBlock = false;
  private thinkingBlockOpen = false;
  private pendingText = "";
  private toolBlockByID = new Map<string, number>();
  private toolBlockByIndex = new Map<number, AnthropicToolBlock>();
  private openToolBlocks = new Map<number, boolean>();
  inputTokens = 0;
  outputTokens = 0;
  private finishReason = "";
  private generatedToolUses = 0;

  constructor(
    private writer: { write(chunk: string): Promise<void>; flush?(): void },
    keepThinkingOpen: boolean,
  ) {
    this.keepThinkingOpen = keepThinkingOpen;
  }

  process(chunk: string): void {
    this.scanner.process(chunk, (event) => this.processEvent(event));
  }

  flush(): void {
    this.scanner.flush((event) => this.processEvent(event));
  }

  private processEvent(event: { data: string }): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      return;
    }
    const usage = parsed["usage"];
    if (usage && typeof usage === "object") {
      const u = usage as Record<string, unknown>;
      const input = numberAsInt(u["prompt_tokens"]);
      if (input > 0) {
        this.inputTokens = input;
      } else {
        const input2 = numberAsInt(u["input_tokens"]);
        if (input2 > 0) this.inputTokens = input2;
      }
      const output = numberAsInt(u["completion_tokens"]);
      if (output > 0) {
        this.outputTokens = output;
      } else {
        const output2 = numberAsInt(u["output_tokens"]);
        if (output2 > 0) this.outputTokens = output2;
      }
    }
    const choices = (parsed["choices"] ?? []) as unknown[];
    if (choices.length === 0) return;
    const choice = (choices[0] ?? {}) as Record<string, unknown>;
    const delta = (choice["delta"] ?? {}) as Record<string, unknown>;
    const reasoning = stringValue(delta["reasoning_content"]);
    if (reasoning !== "") this.writeThinkingDelta(reasoning);
    const text = stringValue(delta["content"]);
    if (text !== "") this.writeTextDelta(text);
    const calls = delta["tool_calls"];
    if (Array.isArray(calls)) {
      for (const raw of calls) this.writeToolCallDelta(raw);
    }
    const finish = stringValue(choice["finish_reason"]);
    if (finish !== "") {
      this.closeThinkingBlock();
      this.flushPendingText();
      this.finishReason = mapOpenAIFinishReasonToAnthropic(finish);
    }
  }

  private writeTextDelta(text: string): void {
    if (this.keepThinkingOpen && this.thinkingBlockOpen) {
      if (this.pendingText !== "") {
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
      writeAnthropicEvent(this.writer, "content_block_start", { type: "content_block_start", index: this.blockIndex, content_block: { type: "text", text: "" } });
      this.openBlockType = "text";
    }
    writeAnthropicEvent(this.writer, "content_block_delta", { type: "content_block_delta", index: this.blockIndex, delta: { type: "text_delta", text } });
  }

  private writeThinkingDelta(thinking: string): void {
    if (!this.keepThinkingOpen) {
      if (this.openBlockType !== "thinking") {
        this.closeOpenToolBlocks();
        this.closeOpenBlock();
        writeAnthropicEvent(this.writer, "content_block_start", { type: "content_block_start", index: this.blockIndex, content_block: { type: "thinking", thinking: "" } });
        this.openBlockType = "thinking";
      }
      writeAnthropicEvent(this.writer, "content_block_delta", { type: "content_block_delta", index: this.blockIndex, delta: { type: "thinking_delta", thinking } });
      return;
    }
    if (this.hasThinkingBlock && !this.thinkingBlockOpen) {
      if (this.openBlockType !== "thinking") {
        this.closeOpenToolBlocks();
        this.closeOpenBlock();
        writeAnthropicEvent(this.writer, "content_block_start", { type: "content_block_start", index: this.blockIndex, content_block: { type: "thinking", thinking: "" } });
        this.openBlockType = "thinking";
      }
      writeAnthropicEvent(this.writer, "content_block_delta", { type: "content_block_delta", index: this.blockIndex, delta: { type: "thinking_delta", thinking } });
      return;
    }

    if (!this.hasThinkingBlock) {
      this.closeOpenToolBlocks();
      this.closeOpenBlock();
      this.thinkingBlock = this.blockIndex;
      this.hasThinkingBlock = true;
      this.thinkingBlockOpen = true;
      writeAnthropicEvent(this.writer, "content_block_start", { type: "content_block_start", index: this.blockIndex, content_block: { type: "thinking", thinking: "" } });
      this.blockIndex++;
      this.openBlockType = "thinking";
    }
    writeAnthropicEvent(this.writer, "content_block_delta", { type: "content_block_delta", index: this.thinkingBlock, delta: { type: "thinking_delta", thinking } });
  }

  private writeToolCallDelta(raw: unknown): void {
    this.closeThinkingBlock();
    this.flushPendingText();
    const call = (raw ?? {}) as Record<string, unknown>;
    const fn = (call["function"] ?? {}) as Record<string, unknown>;
    const openAIIndex = numberAsInt(call["index"]);
    let id = stringValue(call["id"]);
    if (id === "") id = stringValue(call["call_id"]);
    if (id === "") id = this.toolBlockByIndex.get(openAIIndex)?.id ?? "";
    if (id === "") id = this.toolCallID(openAIIndex);
    const index = this.ensureToolBlock(openAIIndex, id, stringValue(fn["name"]));
    const arguments_ = stringValue(fn["arguments"]);
    if (arguments_ !== "") {
      writeAnthropicEvent(this.writer, "content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: arguments_ } });
    }
  }

  private ensureToolBlock(openAIIndex: number, id: string, name: string): number {
    this.closeOpenBlock();
    const existing = this.toolBlockByID.get(id);
    if (existing !== undefined) return existing;
    const index = this.blockIndex;
    this.blockIndex++;
    this.toolBlockByID.set(id, index);
    this.toolBlockByIndex.set(openAIIndex, { index, id });
    this.openToolBlocks.set(index, true);
    writeAnthropicEvent(this.writer, "content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } });
    return index;
  }

  private toolCallID(index: number): string {
    if (index >= this.generatedToolUses) {
      this.generatedToolUses = index + 1;
    }
    if (index < 0) {
      this.generatedToolUses++;
      index = this.generatedToolUses;
    }
    return "toolu_" + timestampCompact() + "_" + index;
  }

  private closeOpenBlock(): void {
    if (this.openBlockType === "") return;
    if (this.keepThinkingOpen && this.thinkingBlockOpen && this.openBlockType === "thinking") {
      this.openBlockType = "";
      return;
    }
    writeAnthropicEvent(this.writer, "content_block_stop", { type: "content_block_stop", index: this.blockIndex });
    this.blockIndex++;
    this.openBlockType = "";
  }

  private closeThinkingBlock(): void {
    if (!this.keepThinkingOpen || !this.hasThinkingBlock || !this.thinkingBlockOpen) return;
    writeAnthropicEvent(this.writer, "content_block_stop", { type: "content_block_stop", index: this.thinkingBlock });
    this.thinkingBlockOpen = false;
    if (this.openBlockType === "thinking") {
      this.openBlockType = "";
    }
  }

  private flushPendingText(): void {
    if (this.pendingText === "") return;
    const text = this.pendingText;
    this.pendingText = "";
    this.writeTextDelta(text);
  }

  private closeOpenToolBlocks(): void {
    if (this.openToolBlocks.size === 0) return;
    const indexes = [...this.openToolBlocks.keys()].sort((a, b) => a - b);
    for (const index of indexes) {
      writeAnthropicEvent(this.writer, "content_block_stop", { type: "content_block_stop", index });
      this.openToolBlocks.delete(index);
    }
  }

  finish(): void {
    this.flush();
    this.closeThinkingBlock();
    this.flushPendingText();
    this.closeOpenBlock();
    this.closeOpenToolBlocks();
    const stopReason = this.finishReason !== "" ? this.finishReason : "end_turn";
    writeAnthropicEvent(this.writer, "message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens } });
    writeAnthropicEvent(this.writer, "message_stop", { type: "message_stop" });
  }
}

function mapOpenAIFinishReasonToAnthropic(reason: string): string {
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

function writeAnthropicEvent(writer: { write(chunk: string): Promise<void>; flush?(): void }, event: string, data: unknown): void {
  const payload = JSON.stringify(data);
  void writer.write("event: " + event + "\n" + "data: " + payload + "\n\n");
  if (writer.flush) writer.flush();
}

function timestampCompact(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

export { contentToTextLocal };
