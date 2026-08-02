import { iterateLines, iterateSSEPayloads, jsonResponse, numberFromAny, randomID, sseResponse, stringValue, defaultStringValue, defaultAny, streamFromString } from "./http.js";
import type { UpstreamResponse } from "./types.js";

export function messagesToResponsesInput(messages: unknown[]): unknown[] {
  const input: unknown[] = [];
  for (const raw of messages) {
    const msg = (raw ?? {}) as Record<string, unknown>;
    const role = stringValue(msg["role"]);
    const content = normalizeResponsesContent(msg["content"], role);
    switch (role) {
      case "system":
      case "developer":
        input.push({ type: "message", role: "developer", content });
        break;
      case "user":
        input.push({ type: "message", role: "user", content });
        break;
      case "assistant": {
        const calls = msg["tool_calls"];
        if (Array.isArray(calls) && calls.length > 0) {
          if (content !== undefined && contentToText(content) !== "") {
            input.push({ type: "message", role: "assistant", content });
          }
          for (const rawCall of calls) {
            const call = (rawCall ?? {}) as Record<string, unknown>;
            const fn = (call["function"] ?? {}) as Record<string, unknown>;
            const name = stringValue(fn["name"]);
            if (name === "") continue;
            const id = toResponsesAPIID(stringValue(call["id"]));
            input.push({ type: "function_call", id, call_id: id, name, arguments: defaultStringValue(fn["arguments"], "{}") });
          }
        } else {
          input.push({ type: "message", role: "assistant", content });
        }
        break;
      }
      case "tool":
        input.push({ type: "function_call_output", call_id: toResponsesAPIID(stringValue(msg["tool_call_id"])), output: contentToText(msg["content"]) });
        break;
      default:
        input.push({ type: "message", role: defaultEmpty(role, "user"), content });
        break;
    }
  }
  return input;
}

export function normalizeResponsesInput(input: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const raw of input) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const copyItem = { ...item };
    const typ = stringValue(copyItem["type"]);
    if (typ === "function_call") {
      const id = toResponsesAPIID(defaultStringValue(copyItem["id"], stringValue(copyItem["call_id"])));
      copyItem["id"] = id;
      copyItem["call_id"] = id;
    }
    if (typ === "function_call_output") {
      copyItem["call_id"] = toResponsesAPIID(stringValue(copyItem["call_id"]));
    }
    if (typ === "message") {
      copyItem["content"] = normalizeResponsesContent(copyItem["content"], defaultStringValue(copyItem["role"], "user"));
    }
    out.push(copyItem);
  }
  return out;
}

export function normalizeResponsesContent(content: unknown, role: string): unknown {
  if (!Array.isArray(content)) return content;
  const targetTextType = role === "assistant" ? "output_text" : "input_text";
  const out: unknown[] = [];
  for (const raw of content) {
    const part = (raw ?? {}) as Record<string, unknown>;
    const copyPart = { ...part };
    if (copyPart["type"] === "text") {
      copyPart["type"] = targetTextType;
    }
    if (copyPart["type"] === "image_url") {
      copyPart["type"] = "input_image";
      const imageURL = (copyPart["image_url"] ?? {}) as Record<string, unknown>;
      copyPart["image_url"] = stringValue(imageURL["url"]);
      if (imageURL["detail"] !== undefined) {
        copyPart["detail"] = imageURL["detail"];
      }
    }
    out.push(copyPart);
  }
  return out;
}

export function extractInstructions(messages: unknown[]): string {
  const parts: string[] = [];
  for (const raw of messages) {
    const msg = (raw ?? {}) as Record<string, unknown>;
    const role = stringValue(msg["role"]);
    if (role !== "system" && role !== "developer") continue;
    const text = contentToText(msg["content"]).trim();
    if (text !== "") parts.push(text);
  }
  return parts.join("\n\n");
}

export function convertToolsForResponses(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const out: unknown[] = [];
  for (const item of raw) {
    let tool = (item ?? {}) as Record<string, unknown>;
    let fn = (tool["function"] ?? {}) as Record<string, unknown>;
    let name = stringValue(fn["name"]);
    if (name === "") {
      name = stringValue(tool["name"]);
      fn = tool;
    }
    if (name === "") continue;
    let params = fn["parameters"];
    if (typeof params !== "object" || params === null) {
      params = { type: "object", properties: {} };
    }
    const converted: Record<string, unknown> = { type: "function", name, description: defaultStringValue(fn["description"], ""), parameters: params };
    if (typeof fn["strict"] === "boolean") converted["strict"] = fn["strict"];
    out.push(converted);
  }
  return out;
}

export function toResponsesAPIID(id: string): string {
  if (id === "") return randomID("fc");
  if (id.startsWith("fc_") || id.startsWith("fc-") || id.startsWith("apc_")) return id;
  if (id.startsWith("call_")) return "fc_" + id.slice(5);
  return "fc_" + id;
}

export function toChatCallID(id: string): string {
  if (id === "") return randomID("call");
  if (id.startsWith("call_")) return id;
  if (id.startsWith("fc_") || id.startsWith("fc-")) return "call_" + id.slice(3);
  return "call_" + id;
}

export function responsesSSEToChatSSEResponse(body: ReadableStream<Uint8Array> | null, model: string): UpstreamResponse {
  return sseResponse(transformResponsesSSEToChat(body, model));
}

export async function* transformResponsesSSEToChat(source: ReadableStream<Uint8Array> | null, model: string): AsyncGenerator<string> {
  const completionID = randomID("chatcmpl");
  let sentRole = false;
  let toolIndex = 0;
  const writeChunk = (delta: Record<string, unknown>, finish: unknown, usage: Record<string, unknown> | null): string => {
    const chunk: Record<string, unknown> = { id: completionID, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] };
    if (usage) chunk["usage"] = usage;
    return "data: " + JSON.stringify(chunk) + "\n\n";
  };

  for await (const data of iterateSSEPayloads(source)) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const typ = stringValue(event["type"]);
    switch (typ) {
      case "response.output_text.delta": {
        if (!sentRole) {
          yield writeChunk({ role: "assistant", content: "" }, null, null);
          sentRole = true;
        }
        const delta = stringValue(event["delta"]);
        if (delta !== "") yield writeChunk({ content: delta }, null, null);
        break;
      }
      case "response.reasoning.delta":
      case "response.reasoning_text.delta":
      case "response.reasoning_summary_text.delta": {
        if (!sentRole) {
          yield writeChunk({ role: "assistant", content: "" }, null, null);
          sentRole = true;
        }
        const delta = stringValue(event["delta"]);
        if (delta !== "") yield writeChunk({ reasoning_content: delta }, null, null);
        break;
      }
      case "response.output_item.added": {
        const item = (event["item"] ?? {}) as Record<string, unknown>;
        if (item["type"] === "function_call") {
          if (!sentRole) {
            yield writeChunk({ role: "assistant" }, null, null);
            sentRole = true;
          }
          const id = toChatCallID(defaultStringValue(item["call_id"], stringValue(item["id"])));
          yield writeChunk({ tool_calls: [{ index: toolIndex, id, type: "function", function: { name: stringValue(item["name"]), arguments: "" } }] }, null, null);
        }
        break;
      }
      case "response.function_call_arguments.delta":
      case "response.custom_tool_call_input.delta": {
        const delta = stringValue(event["delta"]);
        if (delta !== "") {
          yield writeChunk({ tool_calls: [{ index: toolIndex, function: { arguments: delta } }] }, null, null);
        }
        break;
      }
      case "response.function_call_arguments.done":
      case "response.output_item.done": {
        const item = (event["item"] ?? {}) as Record<string, unknown>;
        if (typ === "response.function_call_arguments.done" || item["type"] === "function_call") {
          toolIndex++;
        }
        break;
      }
      case "response.completed":
      case "response.done": {
        const response = (event["response"] ?? event) as Record<string, unknown>;
        const usage = responseUsageToChatUsage(response["usage"]);
        let finish: string = "stop";
        if (response["status"] === "incomplete") finish = "length";
        if (toolIndex > 0) finish = "tool_calls";
        yield writeChunk({}, finish, usage);
        break;
      }
    }
  }
  yield "data: [DONE]\n\n";
}

export function responseUsageToChatUsage(raw: unknown): Record<string, unknown> {
  const usage = (raw ?? {}) as Record<string, unknown>;
  let input = numberFromAny(usage["input_tokens"]);
  if (input === 0) input = numberFromAny(usage["prompt_tokens"]);
  let output = numberFromAny(usage["output_tokens"]);
  if (output === 0) output = numberFromAny(usage["completion_tokens"]);
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

export function responsesJSONToChatCompletion(data: Record<string, unknown>, model: string): Record<string, unknown> {
  let content = "";
  let reasoning = "";
  const toolCalls: unknown[] = [];
  const output = (data["output"] ?? []) as unknown[];
  for (const raw of output) {
    const item = (raw ?? {}) as Record<string, unknown>;
    switch (item["type"]) {
      case "message": {
        const parts = (item["content"] ?? []) as unknown[];
        for (const rawPart of parts) {
          const part = (rawPart ?? {}) as Record<string, unknown>;
          if (part["type"] === "output_text") {
            content += stringValue(part["text"]);
          }
        }
        break;
      }
      case "reasoning":
        reasoning += extractReasoningFromItem(item);
        break;
      case "function_call":
        toolCalls.push({ id: toChatCallID(defaultStringValue(item["call_id"], stringValue(item["id"]))), type: "function", function: { name: stringValue(item["name"]), arguments: defaultStringValue(item["arguments"], "{}") } });
        break;
    }
  }
  const message: Record<string, unknown> = { role: "assistant", content: null };
  if (content !== "") message["content"] = content;
  if (reasoning !== "") message["reasoning_content"] = reasoning;
  if (toolCalls.length > 0) message["tool_calls"] = toolCalls;
  let finish: string = "stop";
  if (data["status"] === "incomplete") finish = "length";
  if (toolCalls.length > 0) finish = "tool_calls";
  return { id: randomID("chatcmpl"), object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message, finish_reason: finish }], usage: responseUsageToChatUsage(data["usage"]) };
}

export function extractReasoningFromItem(item: Record<string, unknown>): string {
  const chunks: string[] = [];
  const text = stringValue(item["text"]);
  if (text !== "") chunks.push(text);
  const summary = item["summary"];
  if (Array.isArray(summary)) {
    for (const raw of summary) {
      if (typeof raw === "string" && raw !== "") {
        chunks.push(raw);
        continue;
      }
      const part = (raw ?? {}) as Record<string, unknown>;
      const partText = stringValue(part["text"]);
      if (partText !== "") chunks.push(partText);
    }
  }
  return chunks.join("\n");
}

export function chatCompletionToResponsesJSON(data: Record<string, unknown>, model: string): Record<string, unknown> {
  const choices = (data["choices"] ?? []) as unknown[];
  let message: Record<string, unknown> = {};
  let finishReason = "stop";
  if (choices.length > 0) {
    const choice = (choices[0] ?? {}) as Record<string, unknown>;
    if (choice) {
      const msg = (choice["message"] ?? {}) as Record<string, unknown>;
      if (msg) message = msg;
      const fr = stringValue(choice["finish_reason"]);
      if (fr !== "") finishReason = fr;
    }
  }
  const output: unknown[] = [];
  const content = stringValue(message["content"]);
  const reasoning = stringValue(message["reasoning_content"]);
  if (reasoning !== "") {
    output.push({ type: "reasoning", text: reasoning });
  }
  if (content !== "") {
    output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: content }] });
  }
  const tcs = (message["tool_calls"] ?? []) as unknown[];
  if (tcs.length > 0) {
    for (const raw of tcs) {
      const tc = (raw ?? {}) as Record<string, unknown>;
      if (!tc) continue;
      const fn = (tc["function"] ?? {}) as Record<string, unknown>;
      const name = stringValue(fn["name"]);
      if (name === "") continue;
      const id = toResponsesAPIID(stringValue(tc["id"]));
      output.push({ type: "function_call", id, call_id: id, name, arguments: defaultStringValue(fn["arguments"], "{}") });
    }
  }
  const usage = (data["usage"] ?? {}) as Record<string, unknown>;
  const status = finishReason === "length" ? "incomplete" : "completed";
  return {
    id: randomID("resp"),
    object: "response",
    model,
    output,
    status,
    usage: { input_tokens: numberFromAny(usage["prompt_tokens"]), output_tokens: numberFromAny(usage["completion_tokens"]), total_tokens: numberFromAny(usage["prompt_tokens"]) + numberFromAny(usage["completion_tokens"]) },
  };
}

interface ChatToolCallState {
  id: string;
  name: string;
  args: string;
}

export function chatSSEToResponsesSSEResponse(body: ReadableStream<Uint8Array> | null, model: string): UpstreamResponse {
  return sseResponse(transformChatSSEToResponses(body, model));
}

export async function* transformChatSSEToResponses(source: ReadableStream<Uint8Array> | null, model: string): AsyncGenerator<string> {
  const responseID = randomID("resp");
  const outputItemID = randomID("item");
  let textContent = "";
  let reasoningContent = "";
  const toolCallsAt = new Map<number, ChatToolCallState>();
  const toolCallIDs: number[] = [];
  const writtenToolCall = new Map<number, boolean>();
  let promptTokens = 0;
  let completionTokens = 0;

  const writeEvent = (event: Record<string, unknown>): string => "data: " + JSON.stringify(event) + "\n\n";

  for await (const data of iterateSSEPayloads(source)) {
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const choices = (chunk["choices"] ?? []) as unknown[];
    if (choices.length === 0) {
      const usage = (chunk["usage"] ?? {}) as Record<string, unknown>;
      if (usage) {
        promptTokens = numberFromAny(usage["prompt_tokens"]);
        completionTokens = numberFromAny(usage["completion_tokens"]);
      }
      continue;
    }
    const choice = (choices[0] ?? {}) as Record<string, unknown>;
    if (!choice) continue;
    const delta = (choice["delta"] ?? {}) as Record<string, unknown>;
    const finishReason = stringValue(choice["finish_reason"]);

    if (delta) {
      const content = stringValue(delta["content"]);
      if (content !== "") {
        textContent += content;
        yield writeEvent({ type: "response.output_text.delta", delta: content, item_id: outputItemID, output_index: 0, content_index: 0 });
      }
      const reasoning = stringValue(delta["reasoning_content"]);
      if (reasoning !== "") {
        reasoningContent += reasoning;
        yield writeEvent({ type: "response.reasoning_text.delta", delta: reasoning, item_id: outputItemID, output_index: 0, content_index: 0 });
      }
      const tcs = (delta["tool_calls"] ?? []) as unknown[];
      if (tcs.length > 0) {
        for (const raw of tcs) {
          const tc = (raw ?? {}) as Record<string, unknown>;
          if (!tc) continue;
          const idx = numberFromAny(tc["index"]);
          const fn = (tc["function"] ?? {}) as Record<string, unknown>;
          let entry = toolCallsAt.get(idx);
          if (!entry) {
            const id = toResponsesAPIID(stringValue(tc["id"]));
            const name = stringValue(fn["name"]);
            entry = { id, name, args: "" };
            toolCallsAt.set(idx, entry);
            toolCallIDs.push(idx);
          }
          const args = stringValue(fn["arguments"]);
          if (args !== "") {
            entry.args += args;
            toolCallsAt.set(idx, entry);
          }
          if (!writtenToolCall.get(idx)) {
            yield writeEvent({ type: "response.output_item.added", item: { type: "function_call", id: entry.id, call_id: entry.id, name: entry.name, arguments: "" } });
            writtenToolCall.set(idx, true);
          }
          if (args !== "") {
            yield writeEvent({ type: "response.function_call_arguments.delta", delta: args, item_id: entry.id, output_index: idx });
          }
        }
      }
    }

    const usage = (choice["usage"] ?? {}) as Record<string, unknown>;
    if (usage) {
      promptTokens = numberFromAny(usage["prompt_tokens"]);
      completionTokens = numberFromAny(usage["completion_tokens"]);
    }

    if (finishReason !== "") {
      const output: unknown[] = [];
      if (reasoningContent !== "") {
        output.push({ type: "reasoning", text: reasoningContent });
      }
      if (textContent !== "") {
        output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: textContent }] });
      }
      for (const idx of toolCallIDs) {
        const entry = toolCallsAt.get(idx);
        if (entry) {
          output.push({ type: "function_call", id: entry.id, call_id: entry.id, name: entry.name, arguments: entry.args });
        }
      }
      const status = finishReason === "length" ? "incomplete" : "completed";
      yield writeEvent({
        type: "response.completed",
        response: {
          id: responseID,
          object: "response",
          model,
          output,
          status,
          usage: { input_tokens: promptTokens, output_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
        },
      });
    }
  }
}

export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const item = content as Record<string, unknown>;
    for (const key of ["text", "input_text", "output_text"]) {
      const value = stringValue(item[key]);
      if (value !== "") return value;
    }
    if (item["content"] !== undefined) return contentToText(item["content"]);
  }
  if (Array.isArray(content)) {
    const chunks: string[] = [];
    for (const raw of content) {
      const part = (raw ?? {}) as Record<string, unknown>;
      for (const key of ["text", "input_text", "output_text"]) {
        const value = stringValue(part[key]);
        if (value !== "") {
          chunks.push(value);
          break;
        }
      }
      if (part["type"] === "tool_result" && part["content"] !== undefined) {
        chunks.push(contentToText(part["content"]));
      }
    }
    return chunks.join("");
  }
  return "";
}

function defaultEmpty(value: string, fallback: string): string {
  return value === "" ? fallback : value;
}
