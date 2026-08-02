import type { EndpointAdapter, ParsedEndpointRequest, RouteError } from "../core/types.js";
import { stringValue } from "../providers/http.js";

export function parseRequiredModel(body: Record<string, unknown>): [string, RouteError | null] {
  const model = stringValue(body["model"]).trim();
  if (model === "") {
    return ["", { status: 400, message: "model is required", type: "invalid_request_error", param: null, code: null, retryAfter: null, retryAfterMS: null, accountID: "" }];
  }
  return [model, null];
}

export function parseStreamParam(body: Record<string, unknown>): boolean {
  return body["stream"] === true;
}

export function buildParamsForError(params: Record<string, unknown>, stream: boolean): Record<string, unknown> {
  return { ...params, stream };
}

export function addSessionID(payload: Record<string, unknown>, sessionID: string): void {
  if (sessionID !== "") {
    payload["_sessionId"] = sessionID;
  }
}

export function cloneMap(input: Record<string, unknown>): Record<string, unknown> {
  return { ...input };
}

export function cloneMapExcept(input: Record<string, unknown>, ...excluded: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!excluded.includes(key)) out[key] = value;
  }
  return out;
}

export function reasoningRequested(body: Record<string, unknown>): boolean {
  if (typeof body["include_thoughts"] === "boolean") return body["include_thoughts"] as boolean;
  const effort = stringValue(body["reasoning_effort"]);
  if (effort !== "") return effort !== "none";
  const reasoning = body["reasoning"];
  if (reasoning && typeof reasoning === "object") {
    const r = reasoning as Record<string, unknown>;
    let includeValue = r["include_thoughts"];
    if (includeValue === undefined) includeValue = r["includeThoughts"];
    if (typeof includeValue === "boolean") return includeValue;
    const rEffort = stringValue(r["effort"]);
    if (rEffort !== "") return rEffort !== "none";
    return true;
  }
  return body["thinking_budget"] !== undefined && body["thinking_budget"] !== null;
}

export function defaultParsed(overrides: Partial<ParsedEndpointRequest> = {}): ParsedEndpointRequest {
  return {
    modelParam: "",
    stream: false,
    forcedAccountID: null,
    reasoningRequested: false,
    messagesForError: undefined,
    paramsForError: {},
    routeData: {},
    ...overrides,
  };
}
