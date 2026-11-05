import { Result } from "effect";
import type {
  Response,
  ResponseFunctionToolCall,
  ResponseInputItem,
  ResponseOutputMessage,
  ResponseReasoningItem,
  ResponseStreamEvent,
} from "@opendum/protocol/openai/responses";
import { emptySampling, emptyUsage, type IrContent, type IrEvent, type IrFinishReason, type IrMessage, type IrRequest, type IrResponse, type IrTool, type IrToolChoice, type IrUsage, type IrImage, type IrText } from "@opendum/protocol/ir";
import { fromResponsesUsage, mergeUsage, toResponsesUsage } from "@opendum/protocol/usage";
import { imageUrlToIr, irImageToUrl } from "@opendum/protocol/openai/chat-codec";

type Mutable<T> = T extends ReadonlyArray<infer Element>
  ? Array<Mutable<Element>>
  : T extends object
    ? { -readonly [Key in keyof T]: T[Key] }
    : T;

type Json = { readonly [key: string]: unknown };

const DEFAULT_MAX_TOKENS = 4096;

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

function parseJson(value: string): unknown {
  const parsed = Result.try({ try: () => JSON.parse(value) as unknown, catch: () => null });
  return Result.isSuccess(parsed) ? parsed.success : null;
}

function contentParts(content: unknown, role: string): Array<IrText | IrImage> {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  const out: Array<IrText | IrImage> = [];
  for (const raw of array(content)) {
    const part = record(raw);
    switch (text(part.type)) {
      case "input_text":
      case "output_text":
      case "text": {
        const value = text(part.text);
        if (value) out.push({ type: "text", text: value });
        break;
      }
      case "refusal": {
        const value = text(part.refusal);
        if (value) out.push({ type: "text", text: value });
        break;
      }
      case "input_image": {
        const image = imageUrlToIr(part.image_url);
        if (image) out.push(image);
        break;
      }
      case "image_url": {
        const image = imageUrlToIr(part.image_url);
        if (image) out.push(image);
        break;
      }
      default:
        break;
    }
  }
  void role;
  return out;
}

function itemType(item: Json): string {
  const type = text(item.type);
  if (type) return type;
  if (item.summary !== undefined || item.encrypted_content !== undefined) return "reasoning";
  if (item.call_id !== undefined && item.name !== undefined) return "function_call";
  if (item.call_id !== undefined && item.output !== undefined) return "function_call_output";
  if (item.role !== undefined) return "message";
  return "";
}

function reasoningText(item: Json): string {
  const chunks: string[] = [];
  for (const collection of [item.summary, item.content]) {
    for (const raw of array(collection)) {
      if (typeof raw === "string") {
        if (raw) chunks.push(raw);
        continue;
      }
      const value = text(record(raw).text);
      if (value) chunks.push(value);
    }
  }
  if (chunks.length === 0) {
    const value = text(item.text);
    if (value) return value;
  }
  return chunks.join("\n\n");
}

function callId(value: string): string {
  if (value.length > 3 && (value.startsWith("fc_") || value.startsWith("fc-"))) {
    return `call_${value.slice(3)}`;
  }
  return value;
}

export function apiCallId(value: string): string {
  if (!value) return value;
  if (value.startsWith("call_")) return `fc_${value.slice("call_".length)}`;
  if (value.startsWith("fc_") || value.startsWith("fc-")) return value;
  return `fc_${value}`;
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  const chunks: string[] = [];
  for (const raw of array(value)) {
    const value = text(record(raw).text);
    if (value) chunks.push(value);
  }
  return chunks.join("\n");
}

function itemsToMessages(input: ReadonlyArray<unknown>, instructions: string): IrMessage[] {
  const messages: IrMessage[] = [];
  if (instructions) messages.push({ role: "system", content: [{ type: "text", text: instructions }] });
  let pendingCalls: IrContent[] = [];
  let pendingReasoning: IrContent | null = null;
  const flush = (): void => {
    if (pendingCalls.length === 0) return;
    const content: IrContent[] = [...pendingCalls];
    if (pendingReasoning) content.unshift(pendingReasoning);
    messages.push({ role: "assistant", content });
    pendingCalls = [];
    pendingReasoning = null;
  };
  for (const raw of input) {
    const item = record(raw);
    switch (itemType(item)) {
      case "message": {
        flush();
        const role = text(item.role);
        const parts: IrContent[] = [...contentParts(item.content, role)];
        if (parts.length === 0) break;
        if (role === "assistant") {
          if (pendingReasoning) parts.unshift(pendingReasoning);
          pendingReasoning = null;
          messages.push({ role: "assistant", content: parts });
        } else if (role === "system" || role === "developer") {
          messages.push({ role: "system", content: parts });
        } else {
          messages.push({ role: "user", content: parts });
        }
        break;
      }
      case "reasoning": {
        const value = reasoningText(item);
        if (value) pendingReasoning = { type: "reasoning", text: value };
        break;
      }
      case "function_call": {
        pendingCalls.push({
          type: "tool_call",
          id: callId(text(item.call_id) || text(item.id)),
          name: text(item.name),
          arguments: text(item.arguments) || "{}",
        });
        break;
      }
      case "function_call_output": {
        flush();
        const parts: Array<IrText | IrImage> = [...contentParts(item.output, "user")];
        if (parts.length === 0) {
          const value = outputText(item.output);
          if (value) parts.push({ type: "text", text: value });
        }
        messages.push({
          role: "tool",
          content: [
            {
              type: "tool_result",
              toolCallId: callId(text(item.call_id)),
              content: parts,
            },
          ],
        });
        break;
      }
      default:
        break;
    }
  }
  flush();
  return messages;
}

function toolToIr(raw: unknown): IrTool | null {
  const tool = record(raw);
  const type = text(tool.type);
  if (type !== "function" && type !== "") return null;
  const fn = record(tool.function);
  const name = text(tool.name) || text(fn.name);
  if (!name) return null;
  const parameters = tool.parameters ?? fn.parameters ?? {};
  const converted: Mutable<IrTool> = { name, parameters };
  const description = text(tool.description) || text(fn.description);
  if (description) converted.description = description;
  const strict = tool.strict ?? fn.strict;
  if (typeof strict === "boolean") converted.strict = strict;
  return converted;
}

function choiceToIr(value: unknown): IrToolChoice | undefined {
  if (value === "auto" || value === "none" || value === "required") return value;
  const choice = record(value);
  if (text(choice.type) === "function") {
    const name = text(choice.name);
    return name ? { name } : undefined;
  }
  return undefined;
}

function reasoningToIr(value: unknown, include: unknown): IrRequest["reasoning"] {
  const reasoning = record(value);
  const effort = text(reasoning.effort);
  const summary = text(reasoning.summary) || text(reasoning.generate_summary);
  const wantsSummary = array(include).includes("reasoning.encrypted_content");
  if (effort || summary) {
    const converted: Mutable<NonNullable<IrRequest["reasoning"]>> = {
      mode: effort === "none" ? "off" : "effort",
    };
    if (effort && effort !== "none") converted.effort = effort;
    if (summary) converted.summary = true;
    if (wantsSummary) converted.signature = true;
    return converted;
  }
  if (wantsSummary) return { mode: "effort", summary: true, signature: true };
  return undefined;
}

export function decodeRequest(body: unknown): IrRequest {
  const params = record(body);
  const instructions = text(params.instructions);
  const input = params.input;
  const items = typeof input === "string" ? [{ role: "user", content: input }] : array(input);
  const messages = itemsToMessages(items, instructions);
  const tools: IrTool[] = [];
  for (const raw of array(params.tools)) {
    const converted = toolToIr(raw);
    if (converted) tools.push(converted);
  }
  const sampling: Mutable<IrRequest["sampling"]> = emptySampling();
  if (typeof params.temperature === "number") sampling.temperature = params.temperature;
  if (typeof params.top_p === "number") sampling.topP = params.top_p;
  sampling.maxTokens = number(params.max_output_tokens) || DEFAULT_MAX_TOKENS;
  const request: Mutable<IrRequest> = {
    model: text(params.model),
    messages,
    tools,
    sampling,
    stream: params.stream === true,
    metadata: {},
  };
  const choice = choiceToIr(params.tool_choice);
  if (choice !== undefined) request.toolChoice = choice;
  if (typeof params.parallel_tool_calls === "boolean") request.parallelToolCalls = params.parallel_tool_calls;
  const reasoning = reasoningToIr(params.reasoning, params.include);
  if (reasoning) request.reasoning = reasoning;
  const previous = text(params.previous_response_id);
  if (previous) request.previousResponseId = previous;
  const user = text(params.user);
  if (user) request.user = user;
  const metadata = record(params.metadata);
  if (Object.keys(metadata).length > 0) {
    request.metadata = Object.fromEntries(
      Object.entries(metadata).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    );
  }
  const format = record(record(params.text).format);
  if (text(format.type) === "json_schema") request.responseFormat = format;
  return request;
}

function messageItems(content: ReadonlyArray<IrContent>, role: "user" | "assistant" | "system"): unknown[] {
  const parts: unknown[] = [];
  const textType = role === "assistant" ? "output_text" : "input_text";
  for (const part of content) {
    if (part.type === "text") parts.push({ type: textType, text: part.text });
    if (part.type === "image") parts.push({ type: "input_image", image_url: irImageToUrl(part) });
  }
  return parts;
}

export function encodeRequest(request: IrRequest): Record<string, unknown> {
  const input: unknown[] = [];
  const system: string[] = [];
  for (const message of request.messages) {
    if (message.role === "system") {
      const value = message.content
        .filter((part) => part.type === "text")
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n\n");
      if (value) system.push(value);
      continue;
    }
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type !== "tool_result") continue;
        const output = part.content.map((item) => (item.type === "text" ? item.text : "")).join("");
        input.push({ type: "function_call_output", call_id: apiCallId(part.toolCallId), output });
      }
      continue;
    }
    if (message.role === "assistant") {
      const reasoning = message.content.find((part) => part.type === "reasoning");
      if (reasoning && reasoning.type === "reasoning" && reasoning.text) {
        input.push({
          type: "reasoning",
          summary: [{ type: "summary_text", text: reasoning.text }],
        });
      }
      const parts = messageItems(message.content, "assistant");
      if (parts.length > 0) input.push({ type: "message", role: "assistant", content: parts });
      for (const part of message.content) {
        if (part.type !== "tool_call") continue;
        input.push({
          type: "function_call",
          call_id: apiCallId(part.id),
          name: part.name,
          arguments: part.arguments,
        });
      }
      continue;
    }
    const parts = messageItems(message.content, "user");
    if (parts.length > 0) input.push({ type: "message", role: "user", content: parts });
  }
  const body: Record<string, unknown> = {
    model: request.model,
    input,
    stream: request.stream,
  };
  if (system.length > 0) body.instructions = system.join("\n\n");
  const sampling = request.sampling;
  if (sampling.temperature !== undefined) body.temperature = sampling.temperature;
  if (sampling.topP !== undefined) body.top_p = sampling.topP;
  if (sampling.maxTokens !== undefined) body.max_output_tokens = sampling.maxTokens;
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => {
      const converted: Record<string, unknown> = {
        type: "function",
        name: tool.name,
        parameters: tool.parameters ?? {},
      };
      if (tool.description) converted.description = tool.description;
      if (tool.strict !== undefined) converted.strict = tool.strict;
      return converted;
    });
    const choice = request.toolChoice;
    if (choice !== undefined) {
      body.tool_choice =
        typeof choice === "string" ? choice : { type: "function", name: choice.name };
    }
    if (request.parallelToolCalls !== undefined) body.parallel_tool_calls = request.parallelToolCalls;
  }
  const reasoning = request.reasoning;
  if (reasoning && reasoning.mode !== "off") {
    const converted: Record<string, unknown> = {};
    if (reasoning.effort) converted.effort = reasoning.effort;
    if (reasoning.summary) converted.summary = "auto";
    if (Object.keys(converted).length > 0) body.reasoning = converted;
    if (reasoning.signature) body.include = ["reasoning.encrypted_content"];
  }
  if (request.previousResponseId) body.previous_response_id = request.previousResponseId;
  if (request.user) body.user = request.user;
  if (Object.keys(request.metadata).length > 0) body.metadata = request.metadata;
  const format = record(request.responseFormat);
  if (text(format.type) === "json_schema") body.text = { format };
  return body;
}

export function finishFromResponses(status: unknown, hasToolCalls: boolean, incomplete: unknown): IrFinishReason {
  if (hasToolCalls) return "tool_calls";
  const reason = text(record(incomplete).reason);
  if (text(status) === "incomplete" || reason) return "length";
  if (text(status) === "failed") return "stop";
  return "stop";
}

export function finishToResponses(reason: IrFinishReason): { status: string; incomplete: Json | null } {
  if (reason === "length") {
    return { status: "incomplete", incomplete: { reason: "max_output_tokens" } };
  }
  if (reason === "content_filter" || reason === "refusal") {
    return { status: "incomplete", incomplete: { reason: "content_filter" } };
  }
  return { status: "completed", incomplete: null };
}

function reasoningItem(content: ReadonlyArray<IrContent>, id: string): ResponseReasoningItem | null {
  const part = content.find((item) => item.type === "reasoning");
  if (!part || part.type !== "reasoning") return null;
  const item: Mutable<ResponseReasoningItem> = {
    id,
    type: "reasoning",
    summary: part.text ? [{ type: "summary_text", text: part.text }] : [],
  };
  if (part.redacted) item.encrypted_content = part.redacted;
  return item;
}

function messageItem(content: ReadonlyArray<IrContent>, id: string): ResponseOutputMessage | null {
  const parts: Mutable<ResponseOutputMessage["content"]> = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push({ type: "output_text", text: part.text, annotations: [] });
    }
  }
  if (parts.length === 0) return null;
  return {
    id,
    type: "message",
    role: "assistant",
    status: "completed",
    content: parts as ResponseOutputMessage["content"],
  };
}

function callItems(content: ReadonlyArray<IrContent>): ResponseFunctionToolCall[] {
  const out: ResponseFunctionToolCall[] = [];
  for (const part of content) {
    if (part.type !== "tool_call") continue;
    out.push({
      type: "function_call",
      id: apiCallId(part.id),
      call_id: apiCallId(part.id),
      name: part.name,
      arguments: part.arguments,
      status: "completed",
    });
  }
  return out;
}

export function decodeResponse(body: unknown, model: string): IrResponse {
  const data = record(body);
  const content: IrContent[] = [];
  for (const raw of array(data.output)) {
    const item = record(raw);
    switch (itemType(item)) {
      case "reasoning": {
        const value = reasoningText(item);
        const converted: IrContent = { type: "reasoning", text: value };
        const encrypted = text(item.encrypted_content);
        if (encrypted) converted.redacted = encrypted;
        content.push(converted);
        break;
      }
      case "message": {
        content.push(...contentParts(item.content, "assistant"));
        break;
      }
      case "function_call": {
        content.push({
          type: "tool_call",
          id: callId(text(item.call_id) || text(item.id)),
          name: text(item.name),
          arguments: text(item.arguments) || "{}",
        });
        break;
      }
      default:
        break;
    }
  }
  const hasToolCalls = content.some((part) => part.type === "tool_call");
  const finishReason = finishFromResponses(data.status, hasToolCalls, data.incomplete_details);
  const usage = mergeUsage(emptyUsage(), fromResponsesUsage(data.usage));
  return {
    id: text(data.id),
    model: text(data.model) || model,
    content,
    finishReason,
    usage,
    status: finishReason === "length" ? "incomplete" : "completed",
    ...(finishReason === "length" ? { incompleteReason: "max_output_tokens" } : {}),
  };
}

export function encodeResponse(response: IrResponse, createdAt?: number): Response {
  const output: Mutable<Response["output"]> = [];
  const reasoning = reasoningItem(response.content, `rs_${response.id}`);
  if (reasoning) output.push(reasoning);
  const message = messageItem(response.content, `msg_${response.id}`);
  if (message) output.push(message);
  output.push(...callItems(response.content));
  const state = finishToResponses(response.finishReason);
  const text = response.content
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
  return {
    id: response.id,
    object: "response",
    created_at: createdAt ?? Math.floor(Date.now() / 1000),
    model: response.model,
    output: output as Response["output"],
    status: state.status as Response["status"],
    usage: toResponsesUsage(response.usage) as Response["usage"],
    error: null,
    incomplete_details: state.incomplete as Response["incomplete_details"],
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: null,
    top_p: null,
    output_text: text,
  };
}

type ItemState = {
  index: number;
  kind: "reasoning" | "message" | "function_call";
  id: string;
  text: string;
  callId: string;
  name: string;
  args: string;
  added: boolean;
};

export class ResponsesStreamDecoder {
  private usage: IrUsage = emptyUsage();

  private finishReason: IrFinishReason = "stop";

  private readonly items = new Map<string, ItemState>();

  private readonly order: string[] = [];

  private started = false;

  private readonly reasoningParts = new Map<string, string>();

  constructor(private readonly model: string) {}

  decode(event: { event: string; data: string }): IrEvent[] {
    const parsed = parseJson(event.data);
    if (parsed === null) return [];
    const value = record(parsed);
    const type = text(value.type) || event.event;
    const out: IrEvent[] = [];
    switch (type) {
      case "response.created":
      case "response.in_progress": {
        if (!this.started) {
          this.started = true;
          const response = record(value.response);
          out.push({
            type: "start",
            id: text(response.id),
            model: text(response.model) || this.model,
          });
        }
        break;
      }
      case "response.output_item.added": {
        const item = record(value.item);
        const itemTypeValue = text(item.type);
        const id = text(item.id);
        if (itemTypeValue === "function_call") {
          const state: ItemState = {
            index: number(value.output_index),
            kind: "function_call",
            id,
            text: "",
            callId: callId(text(item.call_id) || id),
            name: text(item.name),
            args: "",
            added: true,
          };
          this.items.set(id, state);
          this.order.push(id);
          out.push({ type: "tool_start", index: state.index, id: state.callId, name: state.name });
        } else if (itemTypeValue === "reasoning") {
          this.items.set(id, {
            index: number(value.output_index),
            kind: "reasoning",
            id,
            text: "",
            callId: "",
            name: "",
            args: "",
            added: true,
          });
        } else if (itemTypeValue === "message") {
          this.items.set(id, {
            index: number(value.output_index),
            kind: "message",
            id,
            text: "",
            callId: "",
            name: "",
            args: "",
            added: true,
          });
        }
        break;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const id = text(value.item_id);
        const delta = text(value.delta);
        if (!delta) break;
        const key = `${id}:${number(value.summary_index ?? value.content_index)}`;
        this.reasoningParts.set(key, (this.reasoningParts.get(key) ?? "") + delta);
        out.push({ type: "reasoning_delta", text: delta });
        break;
      }
      case "response.reasoning_summary_text.done":
      case "response.reasoning_text.done":
      case "response.reasoning_summary_part.done": {
        const id = text(value.item_id);
        const part = record(value.part);
        const done = text(value.text) || text(part.text);
        const key = `${id}:${number(value.summary_index ?? value.content_index)}`;
        const current = this.reasoningParts.get(key) ?? "";
        if (done && done.length > current.length && done.startsWith(current)) {
          out.push({ type: "reasoning_delta", text: done.slice(current.length) });
          this.reasoningParts.set(key, done);
        }
        break;
      }
      case "response.output_text.delta": {
        const delta = text(value.delta);
        if (delta) out.push({ type: "text_delta", text: delta });
        break;
      }
      case "response.function_call_arguments.delta":
      case "response.custom_tool_call_input.delta": {
        const id = text(value.item_id);
        const delta = text(value.delta);
        const state = this.items.get(id);
        if (!state || !delta) break;
        state.args += delta;
        out.push({ type: "tool_args_delta", index: state.index, json: delta });
        break;
      }
      case "response.output_item.done": {
        const item = record(value.item);
        const id = text(item.id);
        if (text(item.type) === "reasoning") {
          const done = reasoningText(item);
          const key = `${id}:0`;
          const current = this.reasoningParts.get(key) ?? "";
          if (done && done.length > current.length && done.startsWith(current)) {
            out.push({ type: "reasoning_delta", text: done.slice(current.length) });
            this.reasoningParts.set(key, done);
          }
        }
        break;
      }
      case "response.completed":
      case "response.incomplete":
      case "response.done":
      case "response.failed": {
        const response = record(value.response ?? value);
        this.usage = mergeUsage(this.usage, fromResponsesUsage(response.usage));
        const hasToolCalls = this.order.some((key) => this.items.get(key)?.kind === "function_call");
        this.finishReason = finishFromResponses(response.status, hasToolCalls, response.incomplete_details);
        break;
      }
      case "error": {
        out.push({
          type: "error",
          error: {
            message: text(value.message) || "upstream error",
            type: "api_error",
            ...(text(value.code) ? { code: text(value.code) } : {}),
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

type EncoderItem = {
  index: number;
  id: string;
  kind: "reasoning" | "message" | "function_call";
  text: string;
  callId: string;
  name: string;
  args: string;
};

export class ResponsesStreamEncoder {
  private readonly items = new Map<string, EncoderItem>();

  private readonly order: string[] = [];

  private readonly toolItems = new Map<number, EncoderItem>();

  private id = "";

  private model = "";

  private usage: IrUsage = emptyUsage();

  private started = false;

  private reasoningItem: EncoderItem | null = null;

  private messageItem: EncoderItem | null = null;

  encode(event: IrEvent): Array<{ event: string; data: string }> {
    switch (event.type) {
      case "start":
        return this.start(event.id, event.model);
      case "reasoning_delta":
        return this.reasoning(event.text, event.signature);
      case "text_delta":
        return this.text(event.text);
      case "tool_start":
        return this.toolStart(event);
      case "tool_args_delta":
        return this.toolArgs(event);
      case "finish":
        return this.finish(event.reason, event.usage);
      case "error":
        return [
          {
            event: "",
            data: JSON.stringify({
              type: "error",
              code: event.error.code ?? null,
              message: event.error.message,
              param: null,
            }),
          },
        ];
      default:
        return [];
    }
  }

  private start(id: string, model: string): Array<{ event: string; data: string }> {
    this.started = true;
    this.id = id;
    this.model = model;
    return [
      {
        event: "",
        data: JSON.stringify({
          type: "response.created",
          response: {
            id,
            object: "response",
            created_at: Math.floor(Date.now() / 1000),
            model,
            status: "in_progress",
            output: [],
            error: null,
            incomplete_details: null,
            instructions: null,
            metadata: null,
            parallel_tool_calls: true,
            temperature: null,
            top_p: null,
            output_text: "",
          },
        }),
      },
    ];
  }

  private reasoning(chunk: string, signature: string | undefined): Array<{ event: string; data: string }> {
    if (!chunk) {
      if (!signature || !this.reasoningItem) return [];
      return [];
    }
    const out: Array<{ event: string; data: string }> = [];
    if (!this.reasoningItem) {
      this.closeMessage();
      const index = this.order.length;
      const id = `rs_${this.id}_${index}`;
      const item: EncoderItem = {
        index,
        id,
        kind: "reasoning",
        text: "",
        callId: "",
        name: "",
        args: "",
      };
      this.reasoningItem = item;
      this.items.set(id, item);
      this.order.push(id);
      out.push({
        event: "",
        data: JSON.stringify({
          type: "response.output_item.added",
          output_index: index,
          item: { id, type: "reasoning", status: "in_progress", summary: [] },
        }),
      });
      out.push({
        event: "",
        data: JSON.stringify({
          type: "response.reasoning_summary_part.added",
          item_id: id,
          output_index: index,
          summary_index: 0,
          part: { type: "summary_text", text: "" },
        }),
      });
    }
    this.reasoningItem.text += chunk;
    out.push({
      event: "",
      data: JSON.stringify({
        type: "response.reasoning_summary_text.delta",
        item_id: this.reasoningItem.id,
        output_index: this.reasoningItem.index,
        summary_index: 0,
        delta: chunk,
      }),
    });
    return out;
  }

  private text(chunk: string): Array<{ event: string; data: string }> {
    if (!chunk) return [];
    const out = this.closeReasoning();
    if (!this.messageItem) {
      const index = this.order.length;
      const id = `msg_${this.id}_${index}`;
      const item: EncoderItem = {
        index,
        id,
        kind: "message",
        text: "",
        callId: "",
        name: "",
        args: "",
      };
      this.messageItem = item;
      this.items.set(id, item);
      this.order.push(id);
      out.push({
        event: "",
        data: JSON.stringify({
          type: "response.output_item.added",
          output_index: index,
          item: { id, type: "message", role: "assistant", status: "in_progress", content: [] },
        }),
      });
      out.push({
        event: "",
        data: JSON.stringify({
          type: "response.content_part.added",
          item_id: id,
          output_index: index,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        }),
      });
    }
    this.messageItem.text += chunk;
    out.push({
      event: "",
      data: JSON.stringify({
        type: "response.output_text.delta",
        item_id: this.messageItem.id,
        output_index: this.messageItem.index,
        content_index: 0,
        delta: chunk,
      }),
    });
    return out;
  }

  private toolStart(event: IrEvent): Array<{ event: string; data: string }> {
    if (event.type !== "tool_start") return [];
    const out = [...this.closeReasoning(), ...this.closeMessage()];
    const index = this.order.length;
    const item: EncoderItem = {
      index,
      id: apiCallId(event.id),
      kind: "function_call",
      text: "",
      callId: apiCallId(event.id),
      name: event.name,
      args: "",
    };
    this.items.set(event.id, item);
    this.toolItems.set(event.index, item);
    this.order.push(event.id);
    out.push({
      event: "",
      data: JSON.stringify({
        type: "response.output_item.added",
        output_index: index,
        item: {
          id: item.id,
          type: "function_call",
          status: "in_progress",
          call_id: item.callId,
          name: event.name,
          arguments: "",
        },
      }),
    });
    return out;
  }

  private toolArgs(event: IrEvent): Array<{ event: string; data: string }> {
    if (event.type !== "tool_args_delta") return [];
    const item = this.toolItems.get(event.index);
    if (!item || !event.json) return [];
    item.args += event.json;
    return [
      {
        event: "",
        data: JSON.stringify({
          type: "response.function_call_arguments.delta",
          item_id: item.id,
          output_index: item.index,
          delta: event.json,
        }),
      },
    ];
  }

  private finish(reason: IrFinishReason, usage: IrUsage): Array<{ event: string; data: string }> {
    const out = [...this.closeReasoning(), ...this.closeMessage(), ...this.closeTools()];
    this.usage = usage;
    const state = finishToResponses(reason);
    const output = this.order.flatMap((key) => {
      const item = this.items.get(key);
      return item ? [ResponsesStreamEncoder.render(item)] : [];
    });
    const response: Record<string, unknown> = {
      id: this.id,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model: this.model,
      output,
      status: state.status,
      usage: toResponsesUsage(usage),
      error: null,
      incomplete_details: state.incomplete,
      instructions: null,
      metadata: null,
      parallel_tool_calls: true,
      temperature: null,
      top_p: null,
      output_text: output
        .flatMap((item) => array(record(item).content))
        .map((part) => text(record(part).text))
        .join(""),
    };
    const eventType = state.status === "completed" ? "response.completed" : "response.incomplete";
    out.push({ event: "", data: JSON.stringify({ type: eventType, response }) });
    return out;
  }

  private static render(item: EncoderItem): Record<string, unknown> {
    if (item.kind === "reasoning") {
      return {
        id: item.id,
        type: "reasoning",
        status: "completed",
        summary: item.text ? [{ type: "summary_text", text: item.text }] : [],
      };
    }
    if (item.kind === "message") {
      return {
        id: item.id,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: item.text, annotations: [] }],
      };
    }
    return {
      id: item.id,
      type: "function_call",
      status: "completed",
      call_id: item.callId,
      name: item.name,
      arguments: item.args || "{}",
    };
  }

  private closeReasoning(): Array<{ event: string; data: string }> {
    const item = this.reasoningItem;
    if (!item) return [];
    this.reasoningItem = null;
    return [
      {
        event: "",
        data: JSON.stringify({
          type: "response.reasoning_summary_text.done",
          item_id: item.id,
          output_index: item.index,
          summary_index: 0,
          text: item.text,
        }),
      },
      {
        event: "",
        data: JSON.stringify({
          type: "response.output_item.done",
          output_index: item.index,
          item: ResponsesStreamEncoder.render(item),
        }),
      },
    ];
  }

  private closeMessage(): Array<{ event: string; data: string }> {
    const item = this.messageItem;
    if (!item) return [];
    this.messageItem = null;
    return [
      {
        event: "",
        data: JSON.stringify({
          type: "response.output_text.done",
          item_id: item.id,
          output_index: item.index,
          content_index: 0,
          text: item.text,
        }),
      },
      {
        event: "",
        data: JSON.stringify({
          type: "response.content_part.done",
          item_id: item.id,
          output_index: item.index,
          content_index: 0,
          part: { type: "output_text", text: item.text, annotations: [] },
        }),
      },
      {
        event: "",
        data: JSON.stringify({
          type: "response.output_item.done",
          output_index: item.index,
          item: ResponsesStreamEncoder.render(item),
        }),
      },
    ];
  }

  private closeTools(): Array<{ event: string; data: string }> {
    const out: Array<{ event: string; data: string }> = [];
    for (const key of this.order) {
      const item = this.items.get(key);
      if (!item || item.kind !== "function_call") continue;
      out.push({
        event: "",
        data: JSON.stringify({
          type: "response.function_call_arguments.done",
          item_id: item.id,
          output_index: item.index,
          arguments: item.args || "{}",
        }),
      });
      out.push({
        event: "",
        data: JSON.stringify({
          type: "response.output_item.done",
          output_index: item.index,
          item: ResponsesStreamEncoder.render(item),
        }),
      });
    }
    return out;
  }

  state(): { id: string; model: string; usage: IrUsage; started: boolean } {
    return { id: this.id, model: this.model, usage: this.usage, started: this.started };
  }
}

export type { ResponseStreamEvent, ResponseInputItem };
