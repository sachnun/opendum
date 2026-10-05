import { numberAsInt, stringValue } from "../transport/helpers.ts";
import { SseScanner } from "./sse.ts";
import { usageCacheCounts, usageObject } from "../metering/usage.ts";

type Json = Record<string, unknown>;

export class AnthropicStreamTracker {
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
