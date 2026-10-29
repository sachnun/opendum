import { Result } from "effect";
import type {
  ContentBlockParam,
  MessageCreateParams,
  MessageParam,
  TextBlockParam,
  Tool,
  ToolChoice,
  ThinkingConfigParam,
} from "@opendum/protocol/anthropic/messages";
import { emptySampling, emptyUsage, type IrContent, type IrEvent, type IrFinishReason, type IrImage, type IrMessage, type IrRequest, type IrResponse, type IrText, type IrTool, type IrToolChoice, type IrToolResult, type IrUsage } from "@opendum/protocol/ir";
import { mergeUsage } from "@opendum/protocol/usage";

const DEFAULT_MAX_TOKENS = 4096;
const MIN_THINKING_BUDGET = 1024;

type Mutable<T> = T extends ReadonlyArray<infer Element>
  ? Array<Mutable<Element>>
  : T extends object
    ? { -readonly [Key in keyof T]: T[Key] }
    : T;

type Json = { readonly [key: string]: unknown };

function record(value: unknown): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Json;
}

function array(value: unknown): ReadonlyArray<unknown> {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function parseJson(textValue: string): unknown {
  const parsed = Result.try({ try: () => JSON.parse(textValue) as unknown, catch: () => null });
  return Result.isSuccess(parsed) ? parsed.success : null;
}

function dataUri(value: string): { mediaType: string; data: string } | null {
  if (!value.startsWith("data:")) return null;
  const trimmed = value.slice("data:".length);
  const comma = trimmed.indexOf(",");
  if (comma < 0) return null;
  const header = trimmed.slice(0, comma);
  const data = trimmed.slice(comma + 1);
  if (!data) return null;
  const mediaType = header.endsWith(";base64") ? header.slice(0, -";base64".length) : header;
  return { mediaType: mediaType || "image/png", data };
}

export function imageToIr(source: unknown): IrContent | null {
  const block = record(source);
  const type = text(block.type);
  if (type === "base64" && text(block.data)) {
    return {
      type: "image",
      source: "base64",
      mediaType: text(block.media_type) || "image/png",
      data: text(block.data),
    };
  }
  const url = text(block.url);
  if (!url) return null;
  const parsed = dataUri(url);
  if (parsed) {
    return { type: "image", source: "base64", mediaType: parsed.mediaType, data: parsed.data };
  }
  return { type: "image", source: "url", url };
}

export function irToImageSource(
  block: IrContent
): { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } {
  if (block.type !== "image") return { type: "url", url: "" };
  if (block.source === "base64") {
    return { type: "base64", media_type: block.mediaType, data: block.data };
  }
  return { type: "url", url: block.url };
}

export function irToDataUri(block: IrContent): string {
  if (block.type !== "image") return "";
  if (block.source === "base64") return `data:${block.mediaType};base64,${block.data}`;
  return block.url;
}

function blockToIr(block: unknown, toolResultIds: ReadonlySet<string> | null): IrContent | null {
  const value = record(block);
  switch (text(value.type)) {
    case "text":
      return { type: "text", text: text(value.text) };
    case "image":
      return imageToIr(value.source);
    case "tool_use": {
      const id = text(value.id);
      if (id && toolResultIds && !toolResultIds.has(id)) return null;
      const input = value.input === undefined || value.input === null ? {} : value.input;
      return { type: "tool_call", id, name: text(value.name), arguments: JSON.stringify(input) };
    }
    case "tool_result": {
      const content: Array<IrText | IrImage> = [];
      const raw = value.content;
      if (typeof raw === "string") {
        content.push({ type: "text", text: raw });
      } else {
        for (const part of array(raw)) {
          const converted = blockToIr(part, toolResultIds);
          if (converted && (converted.type === "text" || converted.type === "image")) content.push(converted);
        }
      }
      const result: IrToolResult = {
        type: "tool_result",
        toolCallId: text(value.tool_use_id),
        content,
      };
      if (value.is_error === true) result.isError = true;
      return result;
    }
    case "thinking":
      return { type: "reasoning", text: text(value.thinking), signature: text(value.signature) };
    case "redacted_thinking":
      return { type: "reasoning", text: "", redacted: text(value.data) };
    default:
      return null;
  }
}

function resultIds(messages: ReadonlyArray<MessageParam>): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const value = record(block);
      if (value.type !== "tool_result") continue;
      const id = text(value.tool_use_id);
      if (id) ids.add(id);
    }
  }
  return ids;
}

function systemToIr(system: unknown): IrMessage[] {
  if (typeof system === "string") {
    return system ? [{ role: "system", content: [{ type: "text", text: system }] }] : [];
  }
  const content: IrContent[] = [];
  for (const block of array(system)) {
    const value = record(block);
    if (value.type !== "text") continue;
    const cache = record(value.cache_control).type === "ephemeral";
    content.push({ type: "text", text: text(value.text), cache });
  }
  return content.length > 0 ? [{ role: "system", content }] : [];
}

function toolToIr(tool: unknown): IrTool | null {
  const value = record(tool);
  const name = text(value.name);
  if (!name) return null;
  const parameters = value.input_schema === undefined || value.input_schema === null ? {} : value.input_schema;
  const converted: Mutable<IrTool> = { name, parameters };
  const description = text(value.description);
  if (description) converted.description = description;
  if (value.strict === true) converted.strict = true;
  if (record(value.cache_control).type === "ephemeral") converted.cache = true;
  return converted;
}

function toolChoiceToIr(choice: unknown): IrToolChoice | undefined {
  if (typeof choice === "string") return undefined;
  const value = record(choice);
  switch (text(value.type)) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool": {
      const name = text(value.name);
      return name ? { name } : undefined;
    }
    default:
      return undefined;
  }
}

function reasoningToIr(thinking: unknown, outputConfig: unknown): IrRequest["reasoning"] {
  const config = record(thinking);
  const type = text(config.type);
  if (type === "disabled") return { mode: "off" };
  if (type === "enabled") {
    return { mode: "budget", budget: number(config.budget_tokens) };
  }
  if (type === "adaptive") {
    const effort = text(record(outputConfig).effort);
    return { mode: "effort", effort: effort || "high" };
  }
  return undefined;
}

export function decodeRequest(body: unknown): IrRequest {
  const params = record(body) as Partial<MessageCreateParams> & Json;
  const messages: IrMessage[] = systemToIr(params.system);
  const rawMessages = array(params.messages);
  const ids = resultIds(rawMessages as ReadonlyArray<MessageParam>);
  for (const raw of rawMessages) {
    const message = record(raw);
    const role = text(message.role) === "assistant" ? "assistant" : "user";
    const content: IrContent[] = [];
    const rawContent = message.content;
    if (typeof rawContent === "string") {
      content.push({ type: "text", text: rawContent });
    } else {
      for (const block of array(rawContent)) {
        const converted = blockToIr(block, ids);
        if (converted) content.push(converted);
      }
    }
    if (content.length === 0) continue;
    messages.push({ role, content });
  }
  const tools: IrTool[] = [];
  for (const tool of array(params.tools)) {
    const converted = toolToIr(tool);
    if (converted) tools.push(converted);
  }
  const sampling: Mutable<IrRequest["sampling"]> = emptySampling();
  if (params.temperature !== undefined && params.temperature !== null) sampling.temperature = params.temperature;
  if (params.top_p !== undefined && params.top_p !== null) sampling.topP = params.top_p;
  sampling.maxTokens = number(params.max_tokens) || DEFAULT_MAX_TOKENS;
  const stop = array(params.stop_sequences).filter((value): value is string => typeof value === "string");
  if (stop.length > 0) sampling.stop = stop;
  const toolChoice = toolChoiceToIr(params.tool_choice);
  const request: Mutable<IrRequest> = {
    model: text(params.model),
    messages,
    tools,
    sampling,
    stream: params.stream === true,
    metadata: {},
  };
  if (toolChoice !== undefined) request.toolChoice = toolChoice;
  const parallel = record(params.tool_choice).disable_parallel_tool_use;
  if (typeof parallel === "boolean") request.parallelToolCalls = !parallel;
  const reasoning = reasoningToIr(params.thinking, params.output_config);
  if (reasoning) request.reasoning = reasoning;
  const userId = text(record(params.metadata).user_id);
  if (userId) request.user = userId;
  return request;
}

type WireBlock = ContentBlockParam;

function contentToAnthropic(content: ReadonlyArray<IrContent>): WireBlock[] {
  const blocks: WireBlock[] = [];
  for (const part of content) {
    switch (part.type) {
      case "text": {
        const block: WireBlock = { type: "text", text: part.text };
        if (part.cache) block.cache_control = { type: "ephemeral" };
        blocks.push(block);
        break;
      }
      case "image": {
        blocks.push({ type: "image", source: irToImageSource(part) });
        break;
      }
      case "tool_call":
        blocks.push({
          type: "tool_use",
          id: part.id,
          name: part.name,
          input: parseJson(part.arguments) ?? {},
        });
        break;
      case "tool_result": {
        const parts: WireBlock[] = [];
        for (const item of part.content) {
          if (item.type === "text") parts.push({ type: "text", text: item.text });
          if (item.type === "image") parts.push({ type: "image", source: irToImageSource(item) });
        }
        const single = parts.length === 1 ? parts[0] : undefined;
        const content: string | WireBlock[] =
          parts.length === 0 ? "" : single && single.type === "text" ? single.text : parts;
        const block: WireBlock = {
          type: "tool_result",
          tool_use_id: part.toolCallId,
          content,
        };
        if (part.isError) block.is_error = true;
        blocks.push(block);
        break;
      }
      case "reasoning":
        if (part.redacted) {
          blocks.push({ type: "redacted_thinking", data: part.redacted });
        } else {
          blocks.push({ type: "thinking", thinking: part.text, signature: part.signature ?? "" });
        }
        break;
      default:
        break;
    }
  }
  return blocks;
}

function toolChoiceToWire(choice: IrToolChoice | undefined, parallel: boolean | undefined): ToolChoice | undefined {
  const disable = parallel === false ? true : undefined;
  if (choice === undefined) return undefined;
  if (choice === "auto") return disable ? { type: "auto", disable_parallel_tool_use: true } : { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return disable ? { type: "any", disable_parallel_tool_use: true } : { type: "any" };
  return disable
    ? { type: "tool", name: choice.name, disable_parallel_tool_use: true }
    : { type: "tool", name: choice.name };
}

const EFFORT_BUDGETS: Record<string, number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 64000,
};

function effortBudget(effort: string | undefined): number {
  if (!effort) return 0;
  return EFFORT_BUDGETS[effort.toLowerCase()] ?? 0;
}

function reasoningToWire(
  reasoning: IrRequest["reasoning"],
  maxTokens: number
): ThinkingConfigParam | undefined {
  if (!reasoning || reasoning.mode === "off") return undefined;
  const requested = reasoning.mode === "budget" ? (reasoning.budget ?? 0) : effortBudget(reasoning.effort);
  if (requested <= 0) return undefined;
  const ceiling = Math.max(MIN_THINKING_BUDGET, maxTokens - 1024);
  return {
    type: "enabled",
    budget_tokens: Math.max(MIN_THINKING_BUDGET, Math.min(requested, ceiling)),
  };
}

function systemToWire(blocks: ReadonlyArray<TextBlockParam>): string | TextBlockParam[] | undefined {
  if (blocks.length === 0) return undefined;
  if (blocks.every((block) => !block.cache_control)) {
    return blocks.map((block) => block.text).join("\n\n");
  }
  return [...blocks];
}

export function encodeRequest(request: IrRequest): MessageCreateParams {
  const system: TextBlockParam[] = [];
  const messages: MessageParam[] = [];
  for (const message of request.messages) {
    if (message.role === "system") {
      for (const block of contentToAnthropic(message.content)) {
        if (block.type === "text") system.push(block);
      }
      continue;
    }
    const wire = contentToAnthropic(message.content);
    messages.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: wire,
    });
  }
  const body: Mutable<MessageCreateParams> = {
    model: request.model,
    max_tokens: request.sampling.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages,
  };
  const systemValue = systemToWire(system);
  if (systemValue !== undefined) body.system = systemValue;
  if (request.sampling.temperature !== undefined) body.temperature = request.sampling.temperature;
  if (request.sampling.topP !== undefined) body.top_p = request.sampling.topP;
  if (request.sampling.stop !== undefined && request.sampling.stop.length > 0) {
    body.stop_sequences = [...request.sampling.stop];
  }
  if (request.tools.length > 0) {
    const tools: Tool[] = request.tools.map((tool) => {
      const converted: Tool = { name: tool.name, input_schema: tool.parameters ?? {} };
      if (tool.description) converted.description = tool.description;
      if (tool.cache) converted.cache_control = { type: "ephemeral" };
      return converted;
    });
    body.tools = tools;
    const choice = toolChoiceToWire(request.toolChoice, request.parallelToolCalls);
    if (choice) body.tool_choice = choice;
  }
  const thinking = reasoningToWire(request.reasoning, body.max_tokens);
  if (thinking) body.thinking = thinking;
  if (request.user) body.metadata = { user_id: request.user };
  if (request.stream) body.stream = true;
  return body;
}

export function finishFromAnthropic(reason: unknown, hasToolCalls: boolean): IrFinishReason {
  switch (text(reason)) {
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "refusal";
    case "pause_turn":
      return "pause";
    default:
      return hasToolCalls ? "tool_calls" : "stop";
  }
}

export function finishToAnthropic(reason: IrFinishReason): string {
  switch (reason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "refusal":
      return "refusal";
    case "pause":
      return "pause_turn";
    default:
      return "end_turn";
  }
}

export function decodeResponse(body: unknown, model: string): IrResponse {
  const data = record(body);
  const content: IrContent[] = [];
  let usage = emptyUsage();
  for (const raw of array(data.content)) {
    const converted = blockToIr(raw, null);
    if (converted) content.push(converted);
  }
  usage = mergeUsage(usage, {
    inputTokens: number(record(data.usage).input_tokens),
    outputTokens: number(record(data.usage).output_tokens),
    cachedTokens: number(record(data.usage).cache_read_input_tokens),
    cacheWriteTokens: number(record(data.usage).cache_creation_input_tokens),
  });
  const toolCalls = content.some((part) => part.type === "tool_call");
  const finishReason = finishFromAnthropic(data.stop_reason, toolCalls);
  return {
    id: text(data.id),
    model: text(data.model) || model,
    content,
    finishReason,
    usage,
    status: finishReason === "length" ? "incomplete" : "completed",
    ...(finishReason === "length" ? { incompleteReason: "max_tokens" } : {}),
  };
}

export function encodeResponse(response: IrResponse): Json {
  const content = contentToAnthropic(response.content);
  return {
    id: response.id,
    type: "message",
    role: "assistant",
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
    model: response.model,
    stop_reason: finishToAnthropic(response.finishReason),
    stop_sequence: null,
    usage: {
      input_tokens: response.usage.inputTokens,
      output_tokens: response.usage.outputTokens,
      ...(response.usage.cachedTokens > 0
        ? { cache_read_input_tokens: response.usage.cachedTokens }
        : {}),
      ...(response.usage.cacheWriteTokens > 0
        ? { cache_creation_input_tokens: response.usage.cacheWriteTokens }
        : {}),
    },
  };
}

type AnthropicBlockState = {
  index: number;
  kind: "text" | "thinking" | "tool";
  id: string;
  toolIndex: number;
  signature: string;
  redacted: string;
};

export class AnthropicStreamDecoder {
  private usage: IrUsage = emptyUsage();

  private finishReason: IrFinishReason = "stop";

  private readonly blocks = new Map<number, AnthropicBlockState>();

  private readonly toolIndexByBlock = new Map<number, number>();

  private toolCount = 0;

  constructor(private readonly model: string) {}

  decode(event: { event: string; data: string }): IrEvent[] {
    const parsed = parseJson(event.data);
    const value = record(parsed);
    const type = text(value.type) || event.event;
    const out: IrEvent[] = [];
    switch (type) {
      case "message_start": {
        const message = record(value.message);
        const usage = record(message.usage);
        this.usage = mergeUsage(this.usage, {
          inputTokens: number(usage.input_tokens),
          outputTokens: number(usage.output_tokens),
          cachedTokens: number(usage.cache_read_input_tokens),
          cacheWriteTokens: number(usage.cache_creation_input_tokens),
        });
        out.push({ type: "start", id: text(message.id), model: text(message.model) || this.model });
        break;
      }
      case "content_block_start": {
        const index = number(value.index);
        const block = record(value.content_block);
        const blockType = text(block.type);
        if (blockType === "tool_use" || blockType === "server_tool_use") {
          const toolIndex = this.toolCount;
          this.toolCount += 1;
          this.toolIndexByBlock.set(index, toolIndex);
          this.blocks.set(index, {
            index,
            kind: "tool",
            id: text(block.id),
            toolIndex,
            signature: "",
            redacted: "",
          });
          out.push({
            type: "tool_start",
            index: toolIndex,
            id: text(block.id),
            name: text(block.name),
          });
        } else if (blockType === "thinking") {
          this.blocks.set(index, {
            index,
            kind: "thinking",
            id: "",
            toolIndex: -1,
            signature: "",
            redacted: "",
          });
        } else if (blockType === "redacted_thinking") {
          this.blocks.set(index, {
            index,
            kind: "thinking",
            id: "",
            toolIndex: -1,
            signature: "",
            redacted: text(block.data),
          });
        } else {
          this.blocks.set(index, {
            index,
            kind: "text",
            id: "",
            toolIndex: -1,
            signature: "",
            redacted: "",
          });
        }
        break;
      }
      case "content_block_delta": {
        const index = number(value.index);
        const delta = record(value.delta);
        const state = this.blocks.get(index);
        switch (text(delta.type)) {
          case "text_delta": {
            const chunk = text(delta.text);
            if (chunk) out.push({ type: "text_delta", text: chunk });
            break;
          }
          case "thinking_delta": {
            const chunk = text(delta.thinking);
            if (chunk) out.push({ type: "reasoning_delta", text: chunk });
            break;
          }
          case "signature_delta": {
            if (state) state.signature += text(delta.signature);
            break;
          }
          case "input_json_delta": {
            const chunk = text(delta.partial_json);
            if (chunk) {
              out.push({ type: "tool_args_delta", index: state?.toolIndex ?? 0, json: chunk });
            }
            break;
          }
          default:
            break;
        }
        break;
      }
      case "content_block_stop": {
        const index = number(value.index);
        const state = this.blocks.get(index);
        if (state?.kind === "thinking" && state.signature) {
          out.push({ type: "reasoning_delta", text: "", signature: state.signature });
        }
        if (state?.kind === "thinking" && state.redacted) {
          out.push({ type: "reasoning_delta", text: "", signature: `redacted:${state.redacted}` });
        }
        this.blocks.delete(index);
        break;
      }
      case "message_delta": {
        const delta = record(value.delta);
        const usage = record(value.usage);
        this.usage = mergeUsage(this.usage, {
          inputTokens: number(usage.input_tokens),
          outputTokens: number(usage.output_tokens),
          cachedTokens: number(usage.cache_read_input_tokens),
          cacheWriteTokens: number(usage.cache_creation_input_tokens),
        });
        const stop = text(delta.stop_reason);
        if (stop) this.finishReason = finishFromAnthropic(stop, this.toolCount > 0);
        break;
      }
      case "message_stop":
        break;
      case "error": {
        const error = record(value.error);
        out.push({
          type: "error",
          error: {
            message: text(error.message) || "upstream error",
            type: text(error.type) || "api_error",
          },
        });
        break;
      }
      default:
        break;
    }
    return out;
  }

  finish(): IrEvent {
    return { type: "finish", reason: this.finishReason, usage: this.usage };
  }
}

export class AnthropicStreamEncoder {
  private readonly openBlocks = new Map<string, number>();

  private blockIndex = 0;

  private thinkingBlock: number | null = null;

  private textBlock: number | null = null;

  private readonly toolBlocks = new Map<number, { index: number; id: string; name: string; args: string }>();

  private readonly toolOrder: number[] = [];

  private messageId = "";

  private model = "";

  private finishReason: IrFinishReason = "stop";

  private usage: IrUsage = emptyUsage();

  private started = false;

  encode(event: IrEvent): Array<{ event: string; data: string }> {
    switch (event.type) {
      case "start":
        return this.start(event.id, event.model);
      case "reasoning_delta":
        return this.reasoning(event);
      case "text_delta":
        return this.text(event.text);
      case "tool_start":
        return this.toolStart(event);
      case "tool_args_delta":
        return this.toolArgs(event);
      case "finish":
        return this.finish(event.reason, event.usage);
      case "error":
        return [{ event: "error", data: JSON.stringify({ type: "error", error: event.error }) }];
      default:
        return [];
    }
  }

  state(): { id: string; model: string; finishReason: IrFinishReason; usage: IrUsage; started: boolean } {
    return {
      id: this.messageId,
      model: this.model,
      finishReason: this.finishReason,
      usage: this.usage,
      started: this.started,
    };
  }

  private start(id: string, model: string): Array<{ event: string; data: string }> {
    this.started = true;
    this.messageId = id;
    this.model = model;
    return [
      {
        event: "message_start",
        data: JSON.stringify({
          type: "message_start",
          message: {
            id,
            type: "message",
            role: "assistant",
            content: [],
            model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      },
    ];
  }

  private reasoning(event: IrEvent): Array<{ event: string; data: string }> {
    if (event.type !== "reasoning_delta") return [];
    if (!event.text) {
      if (!event.signature || this.thinkingBlock === null) return [];
      return [
        {
          event: "content_block_delta",
          data: JSON.stringify({
            type: "content_block_delta",
            index: this.thinkingBlock,
            delta: { type: "signature_delta", signature: event.signature },
          }),
        },
      ];
    }
    const out = this.closeText();
    if (this.thinkingBlock === null) {
      const index = this.blockIndex;
      this.blockIndex += 1;
      this.thinkingBlock = index;
      this.openBlocks.set("thinking", index);
      out.push({
        event: "content_block_start",
        data: JSON.stringify({
          type: "content_block_start",
          index,
          content_block: { type: "thinking", thinking: "" },
        }),
      });
    }
    out.push({
      event: "content_block_delta",
      data: JSON.stringify({
        type: "content_block_delta",
        index: this.thinkingBlock,
        delta: { type: "thinking_delta", thinking: event.text },
      }),
    });
    return out;
  }

  private text(chunk: string): Array<{ event: string; data: string }> {
    if (!chunk) return [];
    const out = this.closeThinking();
    if (this.textBlock === null) {
      const index = this.blockIndex;
      this.blockIndex += 1;
      this.textBlock = index;
      this.openBlocks.set("text", index);
      out.push({
        event: "content_block_start",
        data: JSON.stringify({
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        }),
      });
    }
    out.push({
      event: "content_block_delta",
      data: JSON.stringify({
        type: "content_block_delta",
        index: this.textBlock,
        delta: { type: "text_delta", text: chunk },
      }),
    });
    return out;
  }

  private toolStart(event: IrEvent): Array<{ event: string; data: string }> {
    if (event.type !== "tool_start") return [];
    const out = [...this.closeText(), ...this.closeThinking()];
    const index = this.blockIndex;
    this.blockIndex += 1;
    this.toolBlocks.set(event.index, { index, id: event.id, name: event.name, args: "" });
    this.toolOrder.push(event.index);
    out.push({
      event: "content_block_start",
      data: JSON.stringify({
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: event.id, name: event.name, input: {} },
      }),
    });
    return out;
  }

  private toolArgs(event: IrEvent): Array<{ event: string; data: string }> {
    if (event.type !== "tool_args_delta") return [];
    const tool = this.toolBlocks.get(event.index);
    if (!tool || !event.json) return [];
    tool.args += event.json;
    return [
      {
        event: "content_block_delta",
        data: JSON.stringify({
          type: "content_block_delta",
          index: tool.index,
          delta: { type: "input_json_delta", partial_json: event.json },
        }),
      },
    ];
  }

  private finish(reason: IrFinishReason, usage: IrUsage): Array<{ event: string; data: string }> {
    const out = this.closeAll();
    this.finishReason = reason;
    this.usage = usage;
    const payload: Record<string, unknown> = {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
    };
    if (usage.cachedTokens > 0) payload.cache_read_input_tokens = usage.cachedTokens;
    if (usage.cacheWriteTokens > 0) payload.cache_creation_input_tokens = usage.cacheWriteTokens;
    out.push({
      event: "message_delta",
      data: JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: finishToAnthropic(reason), stop_sequence: null },
        usage: payload,
      }),
    });
    out.push({ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) });
    return out;
  }

  private closeText(): Array<{ event: string; data: string }> {
    if (this.textBlock === null) return [];
    const index = this.textBlock;
    this.textBlock = null;
    this.openBlocks.delete("text");
    return [
      { event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index }) },
    ];
  }

  private closeThinking(): Array<{ event: string; data: string }> {
    if (this.thinkingBlock === null) return [];
    const index = this.thinkingBlock;
    this.thinkingBlock = null;
    this.openBlocks.delete("thinking");
    return [
      { event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index }) },
    ];
  }

  private closeTools(): Array<{ event: string; data: string }> {
    const out: Array<{ event: string; data: string }> = [];
    for (const key of this.toolOrder) {
      const tool = this.toolBlocks.get(key);
      if (!tool) continue;
      this.toolBlocks.delete(key);
      out.push({
        event: "content_block_stop",
        data: JSON.stringify({ type: "content_block_stop", index: tool.index }),
      });
    }
    this.toolOrder.length = 0;
    return out;
  }

  private closeAll(): Array<{ event: string; data: string }> {
    return [...this.closeTools(), ...this.closeThinking(), ...this.closeText()];
  }
}
