import { anthropicNonStream, anthropicStream, passthroughNonStream, passthroughStream } from "./stream.js";
import { cloneMap, cloneMapExcept, stringValue } from "./helpers.js";
import { transformAnthropicToOpenAI } from "./anthropic-format.js";
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

