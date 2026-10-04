import {
  cloneAnyMap,
  contentToText,
  defaultEmpty,
  defaultStringValue,
  jsonResponse,
  normalizeToolChoice,
  numberFromAny,
  randomId,
  stringSlice,
  stringValue,
  sseResponse,
  uniqueStrings,
} from "./helpers.js";
import { convertResponsesInputImageURLsToBase64 } from "./images.js";

type Json = Record<string, unknown>;

export function messagesToResponsesInput(messages: unknown[]): unknown[] {
  const input: unknown[] = [];
  for (const raw of messages) {
    const msg = (raw ?? {}) as Json;
    const role = stringValue(msg.role);
    const content = normalizeResponsesContent(msg.content, role);
    switch (role) {
      case "system":
      case "developer":
        input.push({ type: "message", role: "developer", content });
        break;
      case "user":
        input.push({ type: "message", role: "user", content });
        break;
      case "assistant": {
        const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        if (calls.length > 0) {
          if (content != null && contentToText(content) !== "") {
            input.push({ type: "message", role: "assistant", content });
          }
          for (const rawCall of calls) {
            const call = (rawCall ?? {}) as Json;
            const fn = (call.function ?? {}) as Json;
            const name = stringValue(fn.name);
            if (!name) continue;
            const id = toResponsesApiId(stringValue(call.id));
            input.push({
              type: "function_call",
              id,
              call_id: id,
              name,
              arguments: defaultStringValue(fn.arguments, "{}"),
            });
          }
        } else {
          input.push({ type: "message", role: "assistant", content });
        }
        break;
      }
      case "tool":
        input.push({
          type: "function_call_output",
          call_id: toResponsesApiId(stringValue(msg.tool_call_id)),
          output: contentToText(msg.content),
        });
        break;
      default:
        input.push({
          type: "message",
          role: defaultEmpty(role, "user"),
          content,
        });
    }
  }
  return input;
}

export function normalizeResponsesInput(input: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const raw of input) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      out.push(raw);
      continue;
    }
    const item = cloneAnyMap(raw as Json);
    let type = stringValue(item.type);
    if (!type) {
      type = inferResponsesInputType(item);
      if (type) item.type = type;
    }
    if (type === "function_call") {
      const id = toResponsesApiId(defaultStringValue(item.id, stringValue(item.call_id)));
      item.id = id;
      item.call_id = id;
    }
    if (type === "function_call_output") {
      item.call_id = toResponsesApiId(stringValue(item.call_id));
    }
    if (type === "message") {
      item.content = normalizeResponsesContent(item.content, defaultStringValue(item.role, "user"));
    }
    out.push(item);
  }
  return out;
}

function inferResponsesInputType(item: Json): string {
  if ("summary" in item) return "reasoning";
  if ("encrypted_content" in item) return "reasoning";
  if (item.call_id !== undefined && item.name !== undefined) return "function_call";
  if (item.call_id !== undefined && item.output !== undefined) return "function_call_output";
  if (item.role !== undefined) return "message";
  return "";
}

export function normalizeResponsesContent(content: unknown, role: string): unknown {
  if (!Array.isArray(content)) return content;
  const targetTextType = role === "assistant" ? "output_text" : "input_text";
  const out: unknown[] = [];
  for (const raw of content) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      out.push(raw);
      continue;
    }
    const copy = cloneAnyMap(raw as Json);
    if (copy.type === "text") copy.type = targetTextType;
    if (copy.type === "image_url") {
      copy.type = "input_image";
      const imageUrl = copy.image_url;
      if (imageUrl !== null && typeof imageUrl === "object" && !Array.isArray(imageUrl)) {
        const image = imageUrl as Json;
        copy.image_url = stringValue(image.url);
        if (image.detail !== undefined) copy.detail = image.detail;
      }
    }
    out.push(copy);
  }
  return out;
}

export function convertToolsForResponses(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const out: unknown[] = [];
  for (const item of raw) {
    const tool = (item ?? {}) as Json;
    let fn = (tool.function ?? {}) as Json;
    let name = stringValue(fn.name);
    if (!name) {
      name = stringValue(tool.name);
      fn = tool;
    }
    if (!name) continue;
    const params =
      fn.parameters !== null && typeof fn.parameters === "object" && !Array.isArray(fn.parameters)
        ? fn.parameters
        : { type: "object", properties: {} };
    const converted: Json = {
      type: "function",
      name,
      description: defaultStringValue(fn.description, ""),
      parameters: params,
    };
    if (typeof fn.strict === "boolean") converted.strict = fn.strict;
    out.push(converted);
  }
  return out;
}

export function toResponsesApiId(id: string): string {
  if (!id) return randomId("fc");
  if (id.startsWith("fc_") || id.startsWith("fc-") || id.startsWith("apc_")) return id;
  if (id.startsWith("call_")) return `fc_${id.slice("call_".length)}`;
  return `fc_${id}`;
}

export function toChatCallId(id: string): string {
  if (!id) return randomId("call");
  if (id.startsWith("call_")) return id;
  if (id.startsWith("fc_") || id.startsWith("fc-")) return `call_${id.slice(3)}`;
  return `call_${id}`;
}

async function* sseDataLines(source: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const emit = function* (chunk: string): Generator<string> {
    for (const line of chunk.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      yield trimmed.slice("data:".length).trim();
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const data of emit(lines.join("\n"))) yield data;
    }
    buffer += decoder.decode();
    for (const data of emit(buffer)) yield data;
  } finally {
    reader.releaseLock();
  }
}

function toStream(events: AsyncIterable<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = events[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(value));
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

class ReasoningParts {
  private readonly parts = new Map<string, string>();
  private readonly order: string[] = [];

  append(key: string, text: string): { missing: string; isNewPart: boolean } {
    if (!text) return { missing: "", isNewPart: false };
    const existing = this.parts.get(key) ?? "";
    let missing = text;
    if (text.startsWith(existing)) missing = text.slice(existing.length);
    if (!missing) return { missing: "", isNewPart: false };
    const seen = this.parts.has(key);
    this.parts.set(key, existing + missing);
    if (!seen) this.order.push(key);
    return { missing, isNewPart: !seen };
  }

  text(): string {
    const chunks: string[] = [];
    for (const key of this.order) {
      const value = this.parts.get(key);
      if (value) chunks.push(value);
    }
    return chunks.join("\n\n");
  }

  addItem(item: Json, emit: (key: string, text: string) => void): void {
    const summary = Array.isArray(item.summary) ? item.summary : [];
    if (summary.length > 0) {
      summary.forEach((raw, index) => {
        let text = "";
        if (typeof raw === "string") text = raw;
        else if (raw !== null && typeof raw === "object") text = stringValue((raw as Json).text);
        if (text) emit(reasoningKey("summary", index), text);
      });
      return;
    }
    const content = Array.isArray(item.content) ? item.content : [];
    if (content.length > 0) {
      content.forEach((raw, index) => {
        const part = (raw ?? {}) as Json;
        const text = stringValue(part.text);
        if (text) emit(reasoningKey("text", index), text);
      });
      return;
    }
    const text = stringValue(item.text);
    if (text) emit(reasoningKey("text", 0), text);
  }
}

function reasoningKey(family: string, index: unknown): string {
  return `${family}:${numberFromAny(index)}`;
}

async function* transformResponsesSseToChat(
  source: ReadableStream<Uint8Array>,
  model: string
): AsyncGenerator<string> {
  const completionId = randomId("chatcmpl");
  let sentRole = false;
  let toolIndex = 0;
  const reasoning = new ReasoningParts();
  let reasoningEmitted = false;

  const writeChunk = (delta: Json, finish: unknown, usage?: Json): string => {
    const chunk: Json = {
      id: completionId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
    if (usage) chunk.usage = usage;
    return `data: ${JSON.stringify(chunk)}\n\n`;
  };

  const emitReasoning = (key: string, text: string): string[] => {
    const { missing, isNewPart } = reasoning.append(key, text);
    if (!missing) return [];
    const prefix = isNewPart && reasoningEmitted ? "\n\n" : "";
    reasoningEmitted = true;
    const out: string[] = [];
    if (!sentRole) {
      out.push(writeChunk({ role: "assistant", content: "" }, null));
      sentRole = true;
    }
    out.push(writeChunk({ reasoning_content: prefix + missing }, null));
    return out;
  };

  for await (const data of sseDataLines(source)) {
    if (!data || data === "[DONE]") continue;
    let event: Json;
    try {
      event = JSON.parse(data) as Json;
    } catch {
      continue;
    }
    const type = stringValue(event.type);
    switch (type) {
      case "response.output_text.delta": {
        if (!sentRole) {
          yield writeChunk({ role: "assistant", content: "" }, null);
          sentRole = true;
        }
        const delta = stringValue(event.delta);
        if (delta) yield writeChunk({ content: delta }, null);
        break;
      }
      case "response.reasoning.delta":
      case "response.reasoning_text.delta":
        for (const chunk of emitReasoning(reasoningKey("text", event.content_index), stringValue(event.delta))) {
          yield chunk;
        }
        break;
      case "response.reasoning_summary_text.delta":
        for (const chunk of emitReasoning(reasoningKey("summary", event.summary_index), stringValue(event.delta))) {
          yield chunk;
        }
        break;
      case "response.reasoning_text.done":
        for (const chunk of emitReasoning(reasoningKey("text", event.content_index), stringValue(event.text))) {
          yield chunk;
        }
        break;
      case "response.reasoning_summary_text.done":
        for (const chunk of emitReasoning(reasoningKey("summary", event.summary_index), stringValue(event.text))) {
          yield chunk;
        }
        break;
      case "response.reasoning_summary_part.done": {
        const part = (event.part ?? {}) as Json;
        let text = stringValue(part.text);
        if (!text) text = stringValue(event.text);
        for (const chunk of emitReasoning(reasoningKey("summary", event.summary_index), text)) {
          yield chunk;
        }
        break;
      }
      case "response.output_item.added": {
        const item = (event.item ?? {}) as Json;
        if (item.type === "function_call") {
          if (!sentRole) {
            yield writeChunk({ role: "assistant" }, null);
            sentRole = true;
          }
          const id = toChatCallId(defaultStringValue(item.call_id, stringValue(item.id)));
          yield writeChunk(
            {
              tool_calls: [
                {
                  index: toolIndex,
                  id,
                  type: "function",
                  function: { name: stringValue(item.name), arguments: "" },
                },
              ],
            },
            null
          );
        }
        break;
      }
      case "response.function_call_arguments.delta":
      case "response.custom_tool_call_input.delta": {
        const delta = stringValue(event.delta);
        if (delta) {
          yield writeChunk({ tool_calls: [{ index: toolIndex, function: { arguments: delta } }] }, null);
        }
        break;
      }
      case "response.function_call_arguments.done":
      case "response.output_item.done": {
        const item = (event.item ?? {}) as Json;
        if (type === "response.function_call_arguments.done" || item.type === "function_call") {
          toolIndex += 1;
        } else if (item.type === "reasoning") {
          const collected: string[] = [];
          reasoning.addItem(item, (key, text) => {
            collected.push(...emitReasoning(key, text));
          });
          for (const chunk of collected) yield chunk;
        }
        break;
      }
      case "response.completed":
      case "response.done": {
        const response = (event.response ?? event) as Json;
        const usage = responseUsageToChatUsage(response.usage);
        let finish = "stop";
        if (response.status === "incomplete") finish = "length";
        if (toolIndex > 0) finish = "tool_calls";
        yield writeChunk({}, finish, usage);
        break;
      }
      default:
        break;
    }
  }
  yield "data: [DONE]\n\n";
}

export function responseUsageToChatUsage(raw: unknown): Json {
  const usage = (raw ?? {}) as Json;
  let input = numberFromAny(usage.input_tokens);
  if (input === 0) input = numberFromAny(usage.prompt_tokens);
  let output = numberFromAny(usage.output_tokens);
  if (output === 0) output = numberFromAny(usage.completion_tokens);
  const out: Json = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };

  let cached = 0;
  let write = 0;
  const details = usage.input_tokens_details;
  if (details !== null && typeof details === "object") {
    cached = numberFromAny((details as Json).cached_tokens);
    write = numberFromAny((details as Json).cache_write_tokens);
  }
  if (cached === 0 || write === 0) {
    const promptDetails = usage.prompt_tokens_details;
    if (promptDetails !== null && typeof promptDetails === "object") {
      const pd = promptDetails as Json;
      if (cached === 0) cached = numberFromAny(pd.cached_tokens);
      if (write === 0) write = numberFromAny(pd.cache_write_tokens);
    }
  }
  if (cached > 0 || write > 0) {
    out.prompt_tokens_details = { cached_tokens: cached, cache_write_tokens: write };
  }

  let reasoning = 0;
  const outputDetails = usage.output_tokens_details;
  if (outputDetails !== null && typeof outputDetails === "object") {
    reasoning = numberFromAny((outputDetails as Json).reasoning_tokens);
  }
  if (reasoning === 0) {
    const completionDetails = usage.completion_tokens_details;
    if (completionDetails !== null && typeof completionDetails === "object") {
      reasoning = numberFromAny((completionDetails as Json).reasoning_tokens);
    }
  }
  if (reasoning > 0) out.completion_tokens_details = { reasoning_tokens: reasoning };
  return out;
}

export function responsesJsonToChatCompletion(data: Json, model: string): Json {
  let content = "";
  let reasoning = "";
  const toolCalls: unknown[] = [];
  const output = Array.isArray(data.output) ? data.output : [];
  for (const raw of output) {
    const item = (raw ?? {}) as Json;
    switch (item.type) {
      case "message": {
        const parts = Array.isArray(item.content) ? item.content : [];
        for (const rawPart of parts) {
          const part = (rawPart ?? {}) as Json;
          if (part.type === "output_text") content += stringValue(part.text);
        }
        break;
      }
      case "reasoning":
        reasoning += extractReasoningFromItem(item);
        break;
      case "function_call":
        toolCalls.push({
          id: toChatCallId(defaultStringValue(item.call_id, stringValue(item.id))),
          type: "function",
          function: {
            name: stringValue(item.name),
            arguments: defaultStringValue(item.arguments, "{}"),
          },
        });
        break;
      default:
        break;
    }
  }
  const message: Json = { role: "assistant", content: null };
  if (content) message.content = content;
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  let finish = "stop";
  if (data.status === "incomplete") finish = "length";
  if (toolCalls.length > 0) finish = "tool_calls";
  return {
    id: randomId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: responseUsageToChatUsage(data.usage),
  };
}

function extractReasoningFromItem(item: Json): string {
  if (Array.isArray(item.summary)) {
    const text = joinReasoningParts(item.summary);
    if (text) return text;
  }
  if (Array.isArray(item.content)) {
    const text = joinReasoningParts(item.content);
    if (text) return text;
  }
  return stringValue(item.text);
}

function joinReasoningParts(parts: unknown[]): string {
  const chunks: string[] = [];
  for (const raw of parts) {
    if (typeof raw === "string") {
      if (raw) chunks.push(raw);
      continue;
    }
    const part = (raw ?? {}) as Json;
    const text = stringValue(part.text);
    if (text) chunks.push(text);
  }
  return chunks.join("\n\n");
}

export function chatCompletionToResponsesJson(data: Json, model: string): Json {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  let message: Json = {};
  let finishReason = "stop";
  if (choices.length > 0) {
    const choice = (choices[0] ?? {}) as Json;
    const msg = choice.message;
    if (msg !== null && typeof msg === "object" && !Array.isArray(msg)) message = msg as Json;
    const fr = stringValue(choice.finish_reason);
    if (fr) finishReason = fr;
  }
  const output: unknown[] = [];
  const content = stringValue(message.content);
  const reasoning = stringValue(message.reasoning_content);
  if (reasoning) output.push(responsesReasoningItem(reasoning));
  if (content) output.push(responsesMessageItem(content));
  const tcs = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const raw of tcs) {
    const tc = (raw ?? {}) as Json;
    const fn = (tc.function ?? {}) as Json;
    const name = stringValue(fn.name);
    if (!name) continue;
    const id = toResponsesApiId(stringValue(tc.id));
    output.push(responsesFunctionCallItem(id, name, defaultStringValue(fn.arguments, "{}")));
  }
  const usage = (data.usage ?? {}) as Json;
  let status = "completed";
  let incompleteDetails: Json | null = null;
  if (finishReason === "length") {
    status = "incomplete";
    incompleteDetails = { reason: "max_output_tokens" };
  }
  const response: Json = {
    id: randomId("resp"),
    object: "response",
    model,
    output,
    status,
    usage: responsesUsageFromChat(usage),
  };
  if (incompleteDetails) response.incomplete_details = incompleteDetails;
  return response;
}

export function responsesReasoningItem(text: string): Json {
  return {
    id: randomId("rs"),
    type: "reasoning",
    status: "completed",
    summary: [{ type: "summary_text", text }],
  };
}

export function responsesMessageItem(text: string): Json {
  return {
    id: randomId("msg"),
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

export function responsesFunctionCallItem(id: string, name: string, args: string): Json {
  return {
    id,
    type: "function_call",
    status: "completed",
    call_id: id,
    name,
    arguments: defaultStringValue(args, "{}"),
  };
}

export function responsesUsageFromChat(usage: Json): Json {
  const input = numberFromAny(usage.prompt_tokens);
  const output = numberFromAny(usage.completion_tokens);
  let cached = 0;
  let write = 0;
  const details = usage.prompt_tokens_details;
  if (details !== null && typeof details === "object") {
    cached = numberFromAny((details as Json).cached_tokens);
    write = numberFromAny((details as Json).cache_write_tokens);
  }
  let reasoning = 0;
  const completionDetails = usage.completion_tokens_details;
  if (completionDetails !== null && typeof completionDetails === "object") {
    reasoning = numberFromAny((completionDetails as Json).reasoning_tokens);
  }
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached, cache_write_tokens: write },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: reasoning },
    total_tokens: input + output,
  };
}

class ResponsesSseState {
  private sequence = 0;
  private readonly items: unknown[] = [];
  private openKind = "";
  private openId = "";
  private openIndex = 0;
  private openText = "";
  private readonly tools = new Map<number, { index: number; id: string; name: string; args: string }>();
  private toolOrder: number[] = [];

  constructor(
    private readonly write: ((event: Json) => void) | undefined,
    private readonly model: string,
    readonly responseId: string
  ) {}

  finishReason = "";
  usage: Json = {};

  emit(event: Json): void {
    if (!this.write) return;
    event.sequence_number = this.sequence;
    this.sequence += 1;
    this.write(event);
  }

  private appendItem(item: Json, index: number): void {
    this.emit({ type: "response.output_item.done", output_index: index, item });
    this.items.push(item);
  }

  private closeOpenItem(): void {
    if (!this.openKind) return;
    let item: Json | null = null;
    if (this.openKind === "reasoning") {
      item = responsesReasoningItem(this.openText);
      item.id = this.openId;
    } else if (this.openKind === "text") {
      item = responsesMessageItem(this.openText);
      item.id = this.openId;
    }
    if (item) this.appendItem(item, this.openIndex);
    this.openKind = "";
    this.openId = "";
    this.openText = "";
  }

  private closeTool(index: number): void {
    const tool = this.tools.get(index);
    if (!tool) return;
    this.appendItem(responsesFunctionCallItem(tool.id, tool.name, tool.args), tool.index);
    this.tools.delete(index);
  }

  closeTools(): void {
    for (const index of this.toolOrder) this.closeTool(index);
    this.toolOrder = [];
  }

  private closeAll(): void {
    this.closeTools();
    this.closeOpenItem();
  }

  private ensureItem(kind: "reasoning" | "text", id: string): void {
    if (this.openKind === kind && this.openId === id) return;
    this.closeTools();
    this.closeOpenItem();
    this.openKind = kind;
    this.openId = id;
    this.openIndex = this.items.length + this.tools.size;
    const item: Json =
      kind === "reasoning"
        ? { id, type: "reasoning", status: "in_progress", summary: [] }
        : { id, type: "message", role: "assistant", status: "in_progress", content: [] };
    this.emit({ type: "response.output_item.added", output_index: this.openIndex, item });
  }

  addReasoning(text: string): void {
    if (!text) return;
    this.ensureItem("reasoning", "reasoning");
    this.openText += text;
    this.emit({
      type: "response.reasoning_text.delta",
      delta: text,
      item_id: this.openId,
      output_index: this.openIndex,
      content_index: 0,
    });
  }

  addText(text: string): void {
    if (!text) return;
    this.ensureItem("text", "message");
    this.openText += text;
    this.emit({
      type: "response.output_text.delta",
      delta: text,
      item_id: this.openId,
      output_index: this.openIndex,
      content_index: 0,
    });
  }

  addToolDelta(index: number, id: string, name: string, args: string): void {
    let tool = this.tools.get(index);
    if (!tool) {
      this.ensureClosed();
      const toolId = id || randomId("fc");
      tool = { index: this.items.length + this.tools.size, id: toolId, name: "", args: "" };
      this.tools.set(index, tool);
      this.toolOrder.push(index);
      this.emit({
        type: "response.output_item.added",
        output_index: tool.index,
        item: {
          id: tool.id,
          type: "function_call",
          status: "in_progress",
          call_id: tool.id,
          name,
          arguments: "",
        },
      });
    }
    if (name && !tool.name) tool.name = name;
    if (args) {
      tool.args += args;
      this.emit({
        type: "response.function_call_arguments.delta",
        delta: args,
        item_id: tool.id,
        output_index: tool.index,
      });
    }
  }

  private ensureClosed(): void {
    this.closeOpenItem();
  }

  complete(): void {
    this.closeAll();
    const response: Json = {
      id: this.responseId,
      object: "response",
      model: this.model,
      output: this.items,
      status: "completed",
      usage: responsesUsageFromChat(this.usage),
    };
    let eventType = "response.completed";
    if (this.finishReason === "length") {
      response.status = "incomplete";
      response.incomplete_details = { reason: "max_output_tokens" };
      eventType = "response.incomplete";
    }
    this.emit({ type: eventType, response });
  }
}

async function* transformChatSseToResponses(
  source: ReadableStream<Uint8Array>,
  model: string
): AsyncGenerator<string> {
  const buffer: string[] = [];
  const state = new ResponsesSseState(
    (event) => buffer.push(`data: ${JSON.stringify(event)}\n\n`),
    model,
    randomId("resp")
  );
  state.emit({
    type: "response.created",
    response: {
      id: state.responseId,
      object: "response",
      model,
      status: "in_progress",
      output: [],
    },
  });
  for (const chunk of buffer.splice(0)) yield chunk;

  for await (const data of sseDataLines(source)) {
    if (!data) continue;
    if (data === "[DONE]") break;
    let chunk: Json;
    try {
      chunk = JSON.parse(data) as Json;
    } catch {
      continue;
    }
    const usage = chunk.usage;
    if (usage !== null && typeof usage === "object" && Object.keys(usage as Json).length > 0) {
      state.usage = usage as Json;
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    if (choices.length === 0) continue;
    const choice = (choices[0] ?? {}) as Json;
    if (choice.usage !== null && typeof choice.usage === "object") {
      const choiceUsage = choice.usage as Json;
      if (Object.keys(choiceUsage).length > 0) state.usage = choiceUsage;
    }
    const finishReason = stringValue(choice.finish_reason);
    if (finishReason) state.finishReason = finishReason;
    const delta = (choice.delta ?? {}) as Json;
    state.addReasoning(stringValue(delta.reasoning_content));
    state.addText(stringValue(delta.content));
    const tcs = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const raw of tcs) {
      const tc = (raw ?? {}) as Json;
      const fn = (tc.function ?? {}) as Json;
      state.addToolDelta(
        numberFromAny(tc.index),
        toResponsesApiId(stringValue(tc.id)),
        stringValue(fn.name),
        stringValue(fn.arguments)
      );
    }
    for (const chunkOut of buffer.splice(0)) yield chunkOut;
  }
  state.complete();
  for (const chunkOut of buffer.splice(0)) yield chunkOut;
}

export function responsesSseToChatStream(
  source: ReadableStream<Uint8Array>,
  model: string
): ReadableStream<Uint8Array> {
  return toStream(transformResponsesSseToChat(source, model));
}

export function chatSseToResponsesStream(
  source: ReadableStream<Uint8Array>,
  model: string
): ReadableStream<Uint8Array> {
  return toStream(transformChatSseToResponses(source, model));
}

export async function responsesSseToResponsesJson(source: ReadableStream<Uint8Array>): Promise<Json> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as Json;
  let result: Json | null = null;
  for (const line of trimmed.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("data:")) continue;
    const data = text.slice("data:".length).trim();
    if (!data || data === "[DONE]") continue;
    let event: Json;
    try {
      event = JSON.parse(data) as Json;
    } catch {
      continue;
    }
    const type = stringValue(event.type);
    if (
      type === "response.completed" ||
      type === "response.incomplete" ||
      type === "response.failed"
    ) {
      const response = event.response;
      if (response !== null && typeof response === "object") result = response as Json;
    }
  }
  if (!result) throw new Error("responses stream ended without a terminal event");
  return result;
}

export async function chatSseToChatCompletion(
  source: ReadableStream<Uint8Array>,
  model: string
): Promise<Json> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as Json;

  let content = "";
  let reasoning = "";
  let finishReason = "stop";
  let usage: Json | null = null;
  const tools: Array<{ id: string; name: string; args: string }> = [];
  const byIndex = new Map<number, { id: string; name: string; args: string }>();

  for (const line of trimmed.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("data:")) continue;
    const data = text.slice("data:".length).trim();
    if (!data || data === "[DONE]") continue;
    let chunk: Json;
    try {
      chunk = JSON.parse(data) as Json;
    } catch {
      continue;
    }
    const usageValue = chunk.usage;
    if (usageValue !== null && typeof usageValue === "object" && Object.keys(usageValue as Json).length > 0) {
      usage = usageValue as Json;
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    if (choices.length === 0) continue;
    const choice = (choices[0] ?? {}) as Json;
    if (!choice) continue;
    const delta = choice.delta;
    if (delta !== null && typeof delta === "object") {
      const d = delta as Json;
      content += stringValue(d.content);
      reasoning += stringValue(d.reasoning_content);
      const calls = Array.isArray(d.tool_calls) ? d.tool_calls : [];
      for (const rawCall of calls) {
        const call = (rawCall ?? {}) as Json;
        const fn = (call.function ?? {}) as Json;
        const index = numberFromAny(call.index);
        let tool = byIndex.get(index);
        if (!tool) {
          tool = { id: stringValue(call.id), name: stringValue(fn.name), args: "" };
          byIndex.set(index, tool);
          tools.push(tool);
        }
        if (!tool.id) tool.id = stringValue(call.id);
        if (!tool.name) tool.name = stringValue(fn.name);
        tool.args += stringValue(fn.arguments);
      }
    }
    const finish = stringValue(choice.finish_reason);
    if (finish) finishReason = finish;
  }

  const message: Json = { role: "assistant", content: null };
  if (content) message.content = content;
  if (reasoning) message.reasoning_content = reasoning;
  if (tools.length > 0) {
    message.tool_calls = tools.map((tool) => ({
      id: tool.id,
      type: "function",
      function: { name: tool.name, arguments: tool.args.trim() || "{}" },
    }));
    if (finishReason === "stop") finishReason = "tool_calls";
  }
  return {
    id: randomId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

export async function adaptChatResponseToResponses(
  resp: Response,
  model: string,
  stream: boolean
): Promise<Response> {
  if (!resp.body) {
    throw new Error("upstream response has no body");
  }
  if (stream) {
    return sseResponse(chatSseToResponsesStream(resp.body, model));
  }
  const data = (await resp.json()) as Json;
  return jsonResponse(200, chatCompletionToResponsesJson(data, model));
}

export interface ResponsesNativeProvider {
  responsesNative(model: string): boolean;
}

export async function adaptForResponsesClient(
  provider: { responsesNative?(model: string): boolean },
  resp: Response,
  payload: Json,
  stream: boolean
): Promise<Response> {
  if (!Array.isArray(payload._responsesInput)) return resp;
  const model = stringValue(payload.model);
  if (typeof provider.responsesNative === "function" && provider.responsesNative(model)) {
    return resp;
  }
  return adaptChatResponseToResponses(resp, model, stream);
}

export function clampPromptCacheKey(key: string): string {
  const chars = [...key];
  if (chars.length > 64) return chars.slice(0, 64).join("");
  return key;
}

export async function buildResponsesApiPayload(
  body: Json,
  modelName: string,
  stream: boolean,
  imageFetch?: (url: string, init?: RequestInit) => Promise<Response>
): Promise<Json> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const payload: Json = { model: modelName, stream };
  if (Array.isArray(body._responsesInput)) {
    payload.input = normalizeResponsesInput(body._responsesInput);
  } else {
    payload.input = messagesToResponsesInput(messages);
  }
  const finishPayload = (input: unknown[]): Json => {
    payload.input = input;
    const instructions = stringValue(body.instructions);
    if (instructions) payload.instructions = instructions;
    if (body.temperature !== undefined && body.temperature !== null) payload.temperature = body.temperature;
    if (body.top_p !== undefined && body.top_p !== null) payload.top_p = body.top_p;
    if (body.max_tokens !== undefined && body.max_tokens !== null) {
      payload.max_output_tokens = body.max_tokens;
    } else if (body.max_completion_tokens !== undefined && body.max_completion_tokens !== null) {
      payload.max_output_tokens = body.max_completion_tokens;
    } else if (body.max_output_tokens !== undefined && body.max_output_tokens !== null) {
      payload.max_output_tokens = body.max_output_tokens;
    }
    const tools = convertToolsForResponses(body.tools);
    if (tools.length > 0) payload.tools = tools;
    if (body.tool_choice !== undefined && body.tool_choice !== null) {
      payload.tool_choice = normalizeToolChoice(body.tool_choice);
    }
    if (body.parallel_tool_calls !== undefined && body.parallel_tool_calls !== null) {
      payload.parallel_tool_calls = body.parallel_tool_calls;
    }
    if (body.reasoning !== null && typeof body.reasoning === "object" && !Array.isArray(body.reasoning)) {
      payload.reasoning = cloneAnyMap(body.reasoning as Json);
    } else {
      const effort = stringValue(body.reasoning_effort);
      if (effort) payload.reasoning = { effort };
    }
    let reasoning = payload.reasoning;
    if (
      reasoning !== null &&
      typeof reasoning === "object" &&
      !Array.isArray(reasoning) &&
      body._includeReasoning === true &&
      (reasoning as Json).summary === undefined
    ) {
      (reasoning as Json).summary = "auto";
    }
    reasoning = undefined;
    let include = stringSlice(body.include);
    if (body._includeReasoning === true) include.push("reasoning.encrypted_content");
    if (include.length > 0) payload.include = uniqueStrings(include);
    for (const key of [
      "previous_response_id",
      "prompt_cache_key",
      "service_tier",
      "store",
      "text",
      "truncation",
      "user",
    ]) {
      if (body[key] !== undefined && body[key] !== null) payload[key] = body[key];
    }
    if (payload.prompt_cache_key === undefined || payload.prompt_cache_key === null) {
      const sessionId = stringValue(body._sessionId);
      if (sessionId) payload.prompt_cache_key = clampPromptCacheKey(sessionId);
    }
    return payload;
  };

  const input = payload.input as unknown[];
  const converted = imageFetch ? await convertResponsesInputImageURLsToBase64(imageFetch, input) : input;
  return finishPayload(converted);
}
