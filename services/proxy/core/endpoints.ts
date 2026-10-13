import { anthropicNonStream, anthropicStream, passthroughNonStream, passthroughStream } from "./stream.js";
import { cloneMap, cloneMapExcept, stringValue } from "./helpers.js";
import type { EndpointAdapter, ParsedEndpointRequest, RouteError } from "./types.js";

type Json = Record<string, unknown>;

export function parseRequiredModel(body: Json): { model: string } | RouteError {
  const model = stringValue(body.model).trim();
  if (!model) {
    return { status: 400, message: "model is required", type: "invalid_request_error" };
  }
  return { model };
}

export function parseStreamParam(body: Json): boolean {
  return body.stream === true;
}

function buildParamsForError(params: Json, stream: boolean): Json {
  return { ...cloneMap(params), stream };
}

function addSessionId(payload: Json, sessionId: string): void {
  if (sessionId) payload._sessionId = sessionId;
}

function reasoningDisabled(body: Json): boolean {
  if (typeof body.include_thoughts === "boolean") return !body.include_thoughts;
  const effort = stringValue(body.reasoning_effort).trim().toLowerCase();
  if (effort) return effort === "none";
  const reasoning = body.reasoning;
  if (reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning)) {
    const r = reasoning as Json;
    const include = r.include_thoughts ?? r.includeThoughts;
    if (typeof include === "boolean" && !include) return true;
    const rEffort = stringValue(r.effort).trim().toLowerCase();
    if (rEffort) return rEffort === "none";
  }
  return false;
}

function reasoningRequested(body: Json): boolean {
  if (reasoningDisabled(body)) return false;
  if (typeof body.include_thoughts === "boolean") return body.include_thoughts;
  if (stringValue(body.reasoning_effort)) return true;
  if (body.reasoning !== null && typeof body.reasoning === "object" && !Array.isArray(body.reasoning)) return true;
  return body.thinking_budget !== undefined && body.thinking_budget !== null;
}

export function chatCompletionsConfig(): EndpointAdapter {
  return {
    endpoint: "chat_completions",
    format: "openai",
    rateLimitStatusCode: 429,
    noAccountsStatusCode: 503,
    parse: parseChatCompletions,
    build: buildChatCompletions,
    handleStream: passthroughStream,
    handleNonStream: passthroughNonStream,
  };
}

function parseChatCompletions(body: Json): ParsedEndpointRequest | RouteError {
  const parsedModel = parseRequiredModel(body);
  if (!("model" in parsedModel)) return parsedModel;
  if (!Array.isArray(body.messages)) {
    return { status: 400, message: "messages array is required", type: "invalid_request_error" };
  }
  const stream = parseStreamParam(body);
  const params = cloneMapExcept(body, "model", "messages", "stream");
  return {
    modelParam: parsedModel.model,
    stream,
    forcedAccountId: null,
    reasoningRequested: reasoningRequested(body),
    messagesForError: body.messages,
    paramsForError: buildParamsForError(params, stream),
    routeData: { messages: body.messages, params },
  };
}

function buildChatCompletions(parsed: ParsedEndpointRequest, model: string, stream: boolean, sessionId: string): Json {
  const params = (parsed.routeData.params ?? {}) as Json;
  const body: Json = cloneMap(params);
  body.model = model;
  body.messages = parsed.routeData.messages;
  body.stream = stream;
  body._includeReasoning = parsed.reasoningRequested;
  addSessionId(body, sessionId);
  return body;
}

export function messagesConfig(): EndpointAdapter {
  return {
    endpoint: "messages",
    format: "anthropic",
    rateLimitStatusCode: 529,
    noAccountsStatusCode: 529,
    parse: parseMessages,
    build: buildMessages,
    handleStream: anthropicStream,
    handleNonStream: anthropicNonStream,
  };
}

function parseMessages(body: Json): ParsedEndpointRequest | RouteError {
  const parsedModel = parseRequiredModel(body);
  if (!("model" in parsedModel)) return parsedModel;
  const stream = parseStreamParam(body);
  const paramsForError = cloneMapExcept(body, "model", "messages", "stream");
  paramsForError.stream = stream;
  return {
    modelParam: parsedModel.model,
    stream,
    forcedAccountId: null,
    reasoningRequested: false,
    messagesForError: body.messages,
    paramsForError,
    routeData: { body },
  };
}

function buildMessages(parsed: ParsedEndpointRequest, model: string, stream: boolean, sessionId: string): Json {
  const body = (parsed.routeData.body ?? {}) as Json;
  const payload = transformAnthropicToOpenAI(body);
  payload.model = model;
  payload.stream = stream;
  addSessionId(payload, sessionId);
  return payload;
}

export function responsesConfig(): EndpointAdapter {
  return {
    endpoint: "responses",
    format: "openai",
    rateLimitStatusCode: 429,
    noAccountsStatusCode: 503,
    parse: parseResponses,
    build: buildResponses,
    handleStream: passthroughStream,
    handleNonStream: passthroughNonStream,
  };
}

function responsesToolsToChat(tools: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const raw of tools) {
    const tool = (raw ?? {}) as Json;
    if (tool.type === "namespace") {
      const name = stringValue(tool.name);
      for (const rawSub of Array.isArray(tool.tools) ? tool.tools : []) {
        const sub = (rawSub ?? {}) as Json;
        const fn = cloneMap(sub);
        delete fn.type;
        if (typeof fn.name === "string") fn.name = name + fn.name;
        out.push({ type: "function", function: fn });
      }
    } else if (tool.type === "function") {
      if (tool.function === undefined) {
        const fn = cloneMap(tool);
        delete fn.type;
        out.push({ type: "function", function: fn });
      } else {
        out.push(raw);
      }
    }
  }
  return out;
}

function responsesContentToChat(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const out: unknown[] = [];
  for (const raw of content) {
    const part = (raw ?? {}) as Json;
    const copyPart = cloneMap(part);
    switch (copyPart.type) {
      case "input_text":
      case "output_text":
        copyPart.type = "text";
        break;
      case "input_image":
        copyPart.type = "image_url";
        if (typeof copyPart.image_url === "string") {
          copyPart.image_url = { url: copyPart.image_url };
        }
        break;
      default:
        break;
    }
    out.push(copyPart);
  }
  return out;
}

function parseResponses(body: Json): ParsedEndpointRequest | RouteError {
  const parsedModel = parseRequiredModel(body);
  if (!("model" in parsedModel)) return parsedModel;
  if (!Array.isArray(body.input)) {
    return { status: 400, message: "input array is required", type: "invalid_request_error" };
  }
  const stream = parseStreamParam(body);
  const instructions = stringValue(body.instructions);
  const messages = convertResponsesInputToMessages(body.input, instructions);
  const params = cloneMapExcept(body, "model", "input", "instructions", "stream");
  if (params.max_output_tokens !== undefined) {
    params.max_tokens = params.max_output_tokens;
    delete params.max_output_tokens;
  }
  const paramsForError = buildParamsForError(params, stream);
  if (instructions) paramsForError.instructions = instructions;
  return {
    modelParam: parsedModel.model,
    stream,
    forcedAccountId: null,
    reasoningRequested: reasoningRequested(params),
    messagesForError: messages,
    paramsForError,
    routeData: { messages, responsesInput: body.input, instructions, params },
  };
}

function buildResponses(parsed: ParsedEndpointRequest, model: string, stream: boolean, sessionId: string): Json {
  const params = (parsed.routeData.params ?? {}) as Json;
  const body: Json = cloneMap(params);
  body.model = model;
  body.messages = parsed.routeData.messages;
  if (Array.isArray(body.tools)) body.tools = responsesToolsToChat(body.tools);
  body.stream = stream;
  body._includeReasoning = parsed.reasoningRequested;
  body._responsesInput = parsed.routeData.responsesInput;
  const instructions = parsed.routeData.instructions;
  if (typeof instructions === "string" && instructions) body.instructions = instructions;
  addSessionId(body, sessionId);
  return body;
}

function convertResponsesInputToMessages(input: unknown[], instructions: string): unknown[] {
  const messages: unknown[] = [];
  if (instructions) messages.push({ role: "system", content: instructions });
  let pendingToolCalls: Json[] = [];
  let pendingReasoning = "";
  const flushToolCalls = (): void => {
    if (pendingToolCalls.length === 0) return;
    const message: Json = { role: "assistant", content: "", tool_calls: pendingToolCalls };
    if (pendingReasoning) {
      message.reasoning_content = pendingReasoning;
      pendingReasoning = "";
    }
    messages.push(message);
    pendingToolCalls = [];
  };
  for (const raw of input) {
    const item = (raw ?? {}) as Json;
    switch (responsesInputItemType(item)) {
      case "message": {
        flushToolCalls();
        let role = stringValue(item.role);
        if (role === "developer") role = "system";
        if (!role) role = "user";
        const message: Json = { role, content: responsesContentToChat(item.content) };
        if (role === "assistant" && pendingReasoning) {
          message.reasoning_content = pendingReasoning;
          pendingReasoning = "";
        }
        messages.push(message);
        break;
      }
      case "reasoning": {
        const text = responsesReasoningText(item);
        if (text) pendingReasoning = pendingReasoning ? `${pendingReasoning}\n\n${text}` : text;
        break;
      }
      case "function_call": {
        let id = stringValue(item.call_id) || stringValue(item.id) || "call_generated";
        id = normalizeCallId(id);
        pendingToolCalls.push({
          id,
          type: "function",
          function: { name: stringValue(item.name), arguments: stringValue(item.arguments) || "{}" },
        });
        break;
      }
      case "function_call_output":
        flushToolCalls();
        messages.push({
          role: "tool",
          content: responsesToolOutputText(item.output),
          tool_call_id: normalizeCallId(stringValue(item.call_id)),
        });
        break;
      default:
        break;
    }
  }
  flushToolCalls();
  return messages;
}

function responsesInputItemType(item: Json): string {
  const type = stringValue(item.type);
  if (type) return type;
  if ("summary" in item) return "reasoning";
  if ("encrypted_content" in item) return "reasoning";
  if (item.call_id != null && item.name != null) return "function_call";
  if (item.call_id != null && item.output != null) return "function_call_output";
  if (item.role != null) return "message";
  return "";
}

function responsesReasoningText(item: Json): string {
  const parts: string[] = [];
  for (const collection of [item.summary, item.content]) {
    if (!Array.isArray(collection)) continue;
    for (const raw of collection) {
      const text = responsesReasoningPartText(raw);
      if (text) parts.push(text);
    }
  }
  if (parts.length === 0) {
    const text = stringValue(item.text);
    if (text) return text;
  }
  return parts.join("\n\n");
}

function responsesReasoningPartText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    return stringValue((raw as Json).text);
  }
  return "";
}

function responsesToolOutputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const chunks: string[] = [];
    for (const raw of value) {
      if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
        const text = stringValue((raw as Json).text);
        if (text) chunks.push(text);
      }
    }
    return chunks.join("\n");
  }
  return "";
}

function normalizeCallId(id: string): string {
  if (id.length > 3 && (id.startsWith("fc_") || id.startsWith("fc-"))) {
    return `call_${id.slice(3)}`;
  }
  return id;
}

export function transformAnthropicToOpenAI(body: Json): Json {
  const payload = cloneMapExcept(body, "system", "thinking", "output_config");
  if (payload.max_tokens === undefined) payload.max_tokens = 4096;
  if (Array.isArray(body.tools)) payload.tools = convertAnthropicTools(body.tools);
  if (body.tool_choice !== undefined) payload.tool_choice = convertAnthropicToolChoice(body.tool_choice);
  const messages: unknown[] = [];
  if (body.system !== undefined && body.system !== null) {
    messages.push({ role: "system", content: anthropicSystemToText(body.system) });
  }
  const toolResultIds = anthropicToolResultIds(body.messages);
  if (Array.isArray(body.messages)) {
    for (const raw of body.messages) messages.push(...convertAnthropicMessage(raw, toolResultIds));
  }
  payload.messages = messages;
  applyAnthropicThinkingParams(payload, body);
  return payload;
}

function convertAnthropicMessage(raw: unknown, toolResultIds: Set<string>): unknown[] {
  const msg = (raw ?? {}) as Json;
  const role = stringValue(msg.role);
  if (typeof msg.content === "string") return [{ role, content: msg.content }];
  if (Array.isArray(msg.content)) {
    const converted = convertAnthropicContentBlocks(msg.content, toolResultIds);
    const messages: unknown[] = [...converted.extraMessages];
    if (converted.parts.length > 0 || converted.toolCalls.length > 0) {
      const message: Json = { role, content: converted.contentValue() };
      if (converted.toolCalls.length > 0) message.tool_calls = converted.toolCalls;
      messages.push(message);
    }
    return messages;
  }
  return [];
}

function convertAnthropicTools(tools: unknown[]): unknown[] {
  const converted: unknown[] = [];
  for (const raw of tools) {
    const tool = (raw ?? {}) as Json;
    if (tool.function !== undefined) {
      converted.push(tool);
      continue;
    }
    const name = stringValue(tool.name);
    if (!name) continue;
    const parameters = tool.input_schema ?? {};
    converted.push({
      type: "function",
      function: { name, description: stringValue(tool.description), parameters },
    });
  }
  return converted;
}

function convertAnthropicToolChoice(toolChoice: unknown): unknown {
  if (typeof toolChoice === "string") {
    if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") return toolChoice;
    return toolChoice;
  }
  if (toolChoice === null || typeof toolChoice !== "object" || Array.isArray(toolChoice)) return toolChoice;
  const choice = toolChoice as Json;
  if (choice.function != null) return choice;
  switch (stringValue(choice.type)) {
    case "auto":
      return "auto";
    case "any":
    case "required":
      return "required";
    case "tool":
    case "function": {
      let name = stringValue(choice.name);
      if (!name && choice.function !== null && typeof choice.function === "object") {
        name = stringValue((choice.function as Json).name);
      }
      return { type: "function", function: { name } };
    }
    case "none":
      return "none";
    default:
      return toolChoice;
  }
}

function applyAnthropicThinkingParams(payload: Json, body: Json): void {
  if (body.max_tokens !== undefined) payload.max_tokens = body.max_tokens;
  const thinking = body.thinking;
  if (thinking === null || typeof thinking !== "object" || Array.isArray(thinking)) return;
  const t = thinking as Json;
  if (t.type === "adaptive") {
    payload.reasoning_effort = anthropicEffort(body);
    payload._includeReasoning = true;
    return;
  }
  if (t.type !== "enabled") return;
  payload.thinking_budget = t.budget_tokens ?? 10000;
  payload._includeReasoning = true;
}

function anthropicEffort(body: Json): string {
  const outputConfig = body.output_config;
  if (outputConfig !== null && typeof outputConfig === "object" && !Array.isArray(outputConfig)) {
    const effort = stringValue((outputConfig as Json).effort);
    if (effort) return effort;
  }
  return "high";
}

type ConvertedBlocks = {
  parts: unknown[];
  toolCalls: unknown[];
  extraMessages: unknown[];
};

function convertAnthropicContentBlocks(blocks: unknown[], toolResultIds: Set<string>): ConvertedBlocks & { contentValue(): unknown } {
  const parts: unknown[] = [];
  const toolCalls: unknown[] = [];
  const extraMessages: unknown[] = [];
  for (const raw of blocks) {
    const block = (raw ?? {}) as Json;
    switch (stringValue(block.type)) {
      case "text": {
        const text = stringValue(block.text);
        if (text) parts.push({ type: "text", text });
        break;
      }
      case "image": {
        const source = block.source;
        if (source !== null && typeof source === "object" && !Array.isArray(source)) {
          const url = stringValue((source as Json).url);
          if (url) parts.push({ type: "image_url", image_url: { url } });
        }
        break;
      }
      case "tool_use": {
        const id = stringValue(block.id);
        if (id && !toolResultIds.has(id)) continue;
        let args = "{}";
        if (block.input !== undefined && block.input !== null) args = JSON.stringify(block.input);
        toolCalls.push({
          id,
          type: "function",
          function: { name: stringValue(block.name), arguments: args },
        });
        break;
      }
      case "tool_result":
        extraMessages.push({
          role: "tool",
          tool_call_id: stringValue(block.tool_use_id),
          content: anthropicToolResultToText(block.content),
        });
        break;
      default:
        break;
    }
  }
  return {
    parts,
    toolCalls,
    extraMessages,
    contentValue(): unknown {
      if (parts.length === 0) return null;
      const texts: string[] = [];
      for (const raw of parts) {
        const part = raw as Json;
        if (part.type !== "text") return parts;
        texts.push(stringValue(part.text));
      }
      return texts.join("");
    },
  };
}

function anthropicToolResultIds(rawMessages: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(rawMessages)) return ids;
  for (const raw of rawMessages) {
    const msg = (raw ?? {}) as Json;
    if (!Array.isArray(msg.content)) continue;
    for (const rawBlock of msg.content) {
      const block = (rawBlock ?? {}) as Json;
      if (block.type !== "tool_result") continue;
      const id = stringValue(block.tool_use_id);
      if (id) ids.add(id);
    }
  }
  return ids;
}

export function transformOpenAIToAnthropic(openAi: Json, model: string): Json {
  const content: unknown[] = [];
  let stopReason = "end_turn";
  const choices = Array.isArray(openAi.choices) ? openAi.choices : [];
  if (choices.length > 0) {
    const choice = (choices[0] ?? {}) as Json;
    const message = (choice.message ?? {}) as Json;
    appendOpenAiMessageContent(content, message);
    const result = appendOpenAiToolCalls(content, message, stopReason);
    stopReason = result.stopReason;
    if (stringValue(choice.finish_reason) === "length") stopReason = "max_tokens";
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  const counts = usageFromJson(openAi);
  const usage: Json = { input_tokens: counts.inputTokens, output_tokens: counts.outputTokens };
  if (counts.cachedTokens > 0) usage.cache_read_input_tokens = counts.cachedTokens;
  if (counts.cacheWriteTokens > 0) usage.cache_creation_input_tokens = counts.cacheWriteTokens;
  return {
    id: `msg_${stringValue(openAi.id) || new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}

function appendOpenAiMessageContent(content: unknown[], message: Json): void {
  const reasoning = stringValue(message.reasoning_content);
  if (reasoning) content.push({ type: "thinking", thinking: reasoning });
  const text = stringValue(message.content);
  if (text) content.push({ type: "text", text });
}

function appendOpenAiToolCalls(
  content: unknown[],
  message: Json,
  stopReason: string
): { stopReason: string } {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const raw of calls) {
    const call = (raw ?? {}) as Json;
    const fn = (call.function ?? {}) as Json;
    let input: Json = {};
    try {
      input = JSON.parse(stringValue(fn.arguments) || "{}") as Json;
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: stringValue(call.id), name: stringValue(fn.name), input });
  }
  return { stopReason: calls.length > 0 ? "tool_use" : stopReason };
}

function anthropicSystemToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const raw of value) {
      const block = (raw ?? {}) as Json;
      if (block.type === "text") parts.push(stringValue(block.text));
    }
    return parts.join("\n");
  }
  return "";
}

function anthropicToolResultToText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? "");
}

import { usageFromJson } from "./usage.js";
