import type { EndpointAdapter, ParsedEndpointRequest, RouteError } from "../core/types.js";
import { parseRequiredModel, parseStreamParam, buildParamsForError, cloneMapExcept, cloneMap, reasoningRequested, addSessionID, defaultParsed } from "./common.js";
import { stringValue, defaultStringValue } from "../providers/http.js";

export function responsesConfig(handlers: { handleStream: EndpointAdapter["handleStream"]; handleNonStream: EndpointAdapter["handleNonStream"] }): EndpointAdapter {
  return {
    endpoint: "responses",
    format: "openai",
    rateLimitStatusCode: 429,
    noAccountsStatusCode: 503,
    parse: parseResponses,
    build: buildResponses,
    handleStream: handlers.handleStream,
    handleNonStream: handlers.handleNonStream,
  };
}

export function responsesToolsToChat(tools: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const raw of tools) {
    if (!raw || typeof raw !== "object") continue;
    const tool = raw as Record<string, unknown>;
    switch (tool["type"]) {
      case "namespace": {
        const name = stringValue(tool["name"]);
        const subs = (tool["tools"] ?? []) as unknown[];
        for (const sub of subs) {
          const subMap = (sub ?? {}) as Record<string, unknown>;
          const fn = { ...subMap };
          delete fn["type"];
          if (typeof fn["name"] === "string") {
            fn["name"] = name + fn["name"];
          }
          out.push({ type: "function", function: fn });
        }
        break;
      }
      case "function":
        if (tool["function"] === undefined) {
          const fn = { ...tool };
          delete fn["type"];
          out.push({ type: "function", function: fn });
        } else {
          out.push(raw);
        }
        break;
    }
  }
  return out;
}

export function responsesContentToChat(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const out: unknown[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") {
      out.push(raw);
      continue;
    }
    const part = { ...(raw as Record<string, unknown>) };
    switch (part["type"]) {
      case "input_text":
      case "output_text":
        part["type"] = "text";
        break;
      case "input_image":
        part["type"] = "image_url";
        if (typeof part["image_url"] === "string") {
          part["image_url"] = { url: part["image_url"] };
        }
        break;
    }
    out.push(part);
  }
  return out;
}

export function parseResponses(body: Record<string, unknown>): [ParsedEndpointRequest, RouteError | null] {
  const [model, routeErr] = parseRequiredModel(body);
  if (routeErr) return [defaultParsed(), routeErr];
  const input = body["input"];
  if (!Array.isArray(input)) {
    return [defaultParsed(), { status: 400, message: "input array is required", type: "invalid_request_error", param: null, code: null, retryAfter: null, retryAfterMS: null, accountID: "" }];
  }
  const stream = parseStreamParam(body);
  const instructions = stringValue(body["instructions"]);
  const messages = convertResponsesInputToMessages(input, instructions);
  const params = cloneMapExcept(body, "model", "input", "instructions", "stream");
  if (params["max_output_tokens"] !== undefined) {
    params["max_tokens"] = params["max_output_tokens"];
    delete params["max_output_tokens"];
  }
  const reasoning = reasoningRequested(params);
  const paramsForError = buildParamsForError(params, stream);
  if (instructions !== "") {
    paramsForError["instructions"] = instructions;
  }
  return [defaultParsed({ modelParam: model, stream, reasoningRequested: reasoning, messagesForError: messages, paramsForError, routeData: { messages, responsesInput: input, instructions, params } }), null];
}

export function buildResponses(parsed: ParsedEndpointRequest, model: string, stream: boolean, sessionID: string): Record<string, unknown> {
  const params = (parsed.routeData["params"] ?? {}) as Record<string, unknown>;
  const body = cloneMap(params);
  body["model"] = model;
  body["messages"] = parsed.routeData["messages"];
  if (Array.isArray(body["tools"])) {
    body["tools"] = responsesToolsToChat(body["tools"] as unknown[]);
  }
  body["stream"] = stream;
  body["_includeReasoning"] = parsed.reasoningRequested;
  body["_responsesInput"] = parsed.routeData["responsesInput"];
  const instructions = stringValue(parsed.routeData["instructions"]);
  if (instructions !== "") {
    body["instructions"] = instructions;
  }
  addSessionID(body, sessionID);
  return body;
}

export function convertResponsesInputToMessages(input: unknown[], instructions: string): unknown[] {
  const messages: unknown[] = [];
  if (instructions !== "") {
    messages.push({ role: "system", content: instructions });
  }
  let pendingToolCalls: Array<Record<string, unknown>> = [];
  const flushToolCalls = () => {
    if (pendingToolCalls.length === 0) return;
    const calls: unknown[] = [];
    for (const call of pendingToolCalls) calls.push(call);
    messages.push({ role: "assistant", content: "", tool_calls: calls });
    pendingToolCalls = [];
  };
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const typeValue = stringValue(item["type"]);
    switch (typeValue) {
      case "message":
        flushToolCalls();
        let role = stringValue(item["role"]);
        if (role === "developer") role = "system";
        if (role === "") role = "user";
        messages.push({ role, content: responsesContentToChat(item["content"]) });
        break;
      case "function_call": {
        let id = stringValue(item["call_id"]);
        if (id === "") id = stringValue(item["id"]);
        if (id === "") id = "call_generated";
        id = normalizeCallID(id);
        pendingToolCalls.push({ id, type: "function", function: { name: stringValue(item["name"]), arguments: defaultStringValue(item["arguments"], "{}") } });
        break;
      }
      case "function_call_output":
        flushToolCalls();
        messages.push({ role: "tool", content: defaultStringValue(item["output"], ""), tool_call_id: normalizeCallID(stringValue(item["call_id"])) });
        break;
    }
  }
  flushToolCalls();
  return messages;
}

export function normalizeCallID(id: string): string {
  if (id.length > 3 && (id.slice(0, 3) === "fc_" || id.slice(0, 3) === "fc-")) {
    return "call_" + id.slice(3);
  }
  return id;
}
