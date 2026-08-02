import type { EndpointAdapter, ParsedEndpointRequest, RouteError } from "../core/types.js";
import { parseRequiredModel, parseStreamParam, buildParamsForError, cloneMapExcept, cloneMap, reasoningRequested, addSessionID, defaultParsed } from "./common.js";

export function chatCompletionsConfig(handlers: { handleStream: EndpointAdapter["handleStream"]; handleNonStream: EndpointAdapter["handleNonStream"] }): EndpointAdapter {
  return {
    endpoint: "chat_completions",
    format: "openai",
    rateLimitStatusCode: 429,
    noAccountsStatusCode: 503,
    parse: parseChatCompletions,
    build: buildChatCompletions,
    handleStream: handlers.handleStream,
    handleNonStream: handlers.handleNonStream,
  };
}

export function parseChatCompletions(body: Record<string, unknown>): [ParsedEndpointRequest, RouteError | null] {
  const [model, routeErr] = parseRequiredModel(body);
  if (routeErr) return [defaultParsed(), routeErr];
  const messages = body["messages"];
  if (!Array.isArray(messages)) {
    return [defaultParsed(), { status: 400, message: "messages array is required", type: "invalid_request_error", param: null, code: null, retryAfter: null, retryAfterMS: null, accountID: "" }];
  }
  const stream = parseStreamParam(body);
  const params = cloneMapExcept(body, "model", "messages", "stream");
  const reasoning = reasoningRequested(body);
  const paramsForError = buildParamsForError(params, stream);
  return [defaultParsed({ modelParam: model, stream, reasoningRequested: reasoning, messagesForError: messages, paramsForError, routeData: { messages, params } }), null];
}

export function buildChatCompletions(parsed: ParsedEndpointRequest, model: string, stream: boolean, sessionID: string): Record<string, unknown> {
  const params = (parsed.routeData["params"] ?? {}) as Record<string, unknown>;
  const body = cloneMap(params);
  body["model"] = model;
  body["messages"] = parsed.routeData["messages"];
  body["stream"] = stream;
  body["_includeReasoning"] = parsed.reasoningRequested;
  addSessionID(body, sessionID);
  return body;
}
