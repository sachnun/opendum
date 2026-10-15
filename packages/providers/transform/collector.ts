import { randomId } from "../core/helpers.js";

type Json = Record<string, unknown>;

export type SseToolCallDelta = {
  /** Groups fragments that belong to the same tool call. */
  key: number | string;
  id?: string;
  type?: string;
  /** Name fragment; `append` concatenates fragments, `first` (default) keeps the first non-empty name. */
  name?: string;
  nameMode?: "append" | "first";
  arguments?: string;
  /** Replaces accumulated arguments instead of appending (sealed tool calls). */
  replaceArguments?: boolean;
};

export type SseCompletionCollectorOptions = {
  model: string;
  /** Completion id, defaults to a random `chatcmpl` id. */
  id?: string;
  /** Id used for tool calls that never carried one, defaults to `call_<key>`. */
  toolIdFallback?: (key: number | string) => string;
  /** Emit accumulated reasoning as `reasoning_content`, defaults to true. */
  includeReasoning?: boolean;
  /** Emit `content: null` instead of an empty string when no text arrived. */
  nullableContent?: boolean;
  /** Normalizes accumulated tool arguments before emitting, defaults to identity. */
  normalizeToolArguments?: (args: string) => string;
  /** Forces `tool_calls` as the finish reason whenever tool calls exist, instead of upgrading only a `stop`. */
  forceToolFinishReason?: boolean;
  /** Usage emitted when the stream never carried any, defaults to `{}`. */
  usageFallback?: Json;
};

type AccumulatedToolCall = {
  id: string;
  type: string;
  name: string;
  arguments: string;
};

/**
 * Accumulates streamed deltas into a single `chat.completion` payload.
 * Providers feed whatever their stream yields (text, reasoning text,
 * tool-call fragments) and read the synthesized completion at the end.
 */
export class SseCompletionCollector {
  private content = "";
  private reasoning = "";
  private finishReason = "stop";
  private usage: Json | null = null;
  private readonly toolCalls = new Map<number | string, AccumulatedToolCall>();

  constructor(private readonly options: SseCompletionCollectorOptions) {}

  addContent(text: string): void {
    this.content += text;
  }

  addReasoning(text: string): void {
    this.reasoning += text;
  }

  addToolCall(delta: SseToolCallDelta): void {
    let call = this.toolCalls.get(delta.key);
    if (!call) {
      call = { id: "", type: "", name: "", arguments: "" };
      this.toolCalls.set(delta.key, call);
    }
    if (delta.id) call.id = delta.id;
    if (delta.type) call.type = delta.type;
    if (delta.name) {
      if (delta.nameMode === "append") call.name += delta.name;
      else if (!call.name) call.name = delta.name;
    }
    if (delta.arguments) {
      if (delta.replaceArguments) call.arguments = delta.arguments;
      else call.arguments += delta.arguments;
    }
  }

  setFinishReason(reason: string): void {
    if (reason) this.finishReason = reason;
  }

  setUsage(usage: Json): void {
    this.usage = usage;
  }

  toCompletion(): Json {
    const normalize = this.options.normalizeToolArguments ?? identity;
    const toolCalls = Array.from(this.toolCalls, ([key, call]) => ({
      id: call.id || (this.options.toolIdFallback ?? defaultToolId)(key),
      type: call.type || "function",
      function: { name: call.name, arguments: normalize(call.arguments) },
    }));
    const message: Json = {
      role: "assistant",
      content: this.options.nullableContent ? this.content || null : this.content,
    };
    if (this.reasoning && this.options.includeReasoning !== false) message.reasoning_content = this.reasoning;
    let finishReason = this.finishReason;
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
      if (finishReason === "stop" || this.options.forceToolFinishReason) finishReason = "tool_calls";
    }
    return {
      id: this.options.id ?? randomId("chatcmpl"),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: this.options.model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: this.usage ?? this.options.usageFallback ?? {},
    };
  }
}

function identity(value: string): string {
  return value;
}

function defaultToolId(key: number | string): string {
  return `call_${key}`;
}
