import { anthropicNonStream, anthropicStream, passthroughNonStream, passthroughStream } from "../streaming/stream.ts";
import { cloneMap, cloneMapExcept, stringValue } from "./helpers.ts";
import { transformAnthropicToOpenAI } from "../streaming/anthropic-format.ts";
import type { EndpointAdapter, ParsedEndpointRequest, RouteError } from "../types.ts";
import { convertResponsesInputToMessages, responsesToolsToChat } from "./responses-convert.ts";

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



