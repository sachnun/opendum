import { Ids } from "@opendum/providers/helpers";

type Json = Record<string, unknown>;

export type ToolCallDelta = {
  key: number | string;
  id?: string;
  type?: string;
  name?: string;
  nameMode?: "append" | "first";
  arguments?: string;
  replaceArgs?: boolean;
};

export type Options = {
  model: string;
  id?: string;
  toolIdFallback?: (key: number | string) => string;
  includeReasoning?: boolean;
  nullContent?: boolean;
  normalizeArgs?: (args: string) => string;
  forceFinish?: boolean;
  usageFallback?: Json;
};

type ToolCall = {
  id: string;
  type: string;
  name: string;
  arguments: string;
};

export class Collector {
  private content = "";
  private reasoning = "";
  private finishReason = "stop";
  private usage: Json | null = null;
  private readonly toolCalls = new Map<number | string, ToolCall>();

  constructor(private readonly options: Options) {}

  addContent(text: string): void {
    this.content += text;
  }

  addReasoning(text: string): void {
    this.reasoning += text;
  }

  addToolCall(delta: ToolCallDelta): void {
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
      if (delta.replaceArgs) call.arguments = delta.arguments;
      else call.arguments += delta.arguments;
    }
  }

  setFinish(reason: string): void {
    if (reason) this.finishReason = reason;
  }

  setUsage(usage: Json): void {
    this.usage = usage;
  }

  toCompletion(): Json {
    const normalize = this.options.normalizeArgs ?? identity;
    const toolCalls = Array.from(this.toolCalls, ([key, call]) => ({
      id: call.id || (this.options.toolIdFallback ?? toolId)(key),
      type: call.type || "function",
      function: { name: call.name, arguments: normalize(call.arguments) },
    }));
    const message: Json = {
      role: "assistant",
      content: this.options.nullContent ? this.content || null : this.content,
    };
    if (this.reasoning && this.options.includeReasoning !== false) message.reasoning_content = this.reasoning;
    let finishReason = this.finishReason;
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
      if (finishReason === "stop" || this.options.forceFinish) finishReason = "tool_calls";
    }
    return {
      id: this.options.id ?? Ids.random("chatcmpl"),
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

function toolId(key: number | string): string {
  return `call_${key}`;
}
