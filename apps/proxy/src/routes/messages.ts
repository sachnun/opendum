import type { EndpointAdapter, ParsedEndpointRequest, RouteError } from "../core/types.js";
import { parseRequiredModel, parseStreamParam, cloneMapExcept, addSessionID, defaultParsed } from "./common.js";
import { transformAnthropicToOpenAI } from "../core/anthropic/transform.js";

export function messagesConfig(handlers: { handleStream: EndpointAdapter["handleStream"]; handleNonStream: EndpointAdapter["handleNonStream"] }): EndpointAdapter {
  return {
    endpoint: "messages",
    format: "anthropic",
    rateLimitStatusCode: 529,
    noAccountsStatusCode: 529,
    parse: parseMessages,
    build: buildMessages,
    handleStream: handlers.handleStream,
    handleNonStream: handlers.handleNonStream,
  };
}

export function parseMessages(body: Record<string, unknown>): [ParsedEndpointRequest, RouteError | null] {
  const [model, routeErr] = parseRequiredModel(body);
  if (routeErr) return [defaultParsed(), routeErr];
  const stream = parseStreamParam(body);
  const paramsForError = cloneMapExcept(body, "model", "messages", "stream");
  paramsForError["stream"] = stream;
  return [defaultParsed({ modelParam: model, stream, messagesForError: body["messages"], paramsForError, routeData: { body } }), null];
}

export function buildMessages(parsed: ParsedEndpointRequest, model: string, stream: boolean, sessionID: string): Record<string, unknown> {
  const body = (parsed.routeData["body"] ?? {}) as Record<string, unknown>;
  const payload = transformAnthropicToOpenAI(body);
  payload["model"] = model;
  payload["stream"] = stream;
  addSessionID(payload, sessionID);
  return payload;
}
