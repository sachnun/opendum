import { Coerce, Records } from "./helpers.js";
import type { ErrorFormat, ParsedEndpointRequest, ResponseContext, RouteError, StreamRecorder } from "./types.js";
import { nonStream, anthropicStream, passthrough, passthroughStream } from "./stream.js";
import { fromChat, toChat } from "./endpoints/anthropic.js";
import { toMessages, toolsOf } from "./endpoints/responses.js";

type Json = Record<string, unknown>;

function requiredModel(body: Json): { model: string } | RouteError {
  const model = Coerce.string(body.model).trim();
  if (!model) {
    return { status: 400, message: "model is required", type: "invalid_request_error" };
  }
  return { model };
}

function streamParam(body: Json): boolean {
  return body.stream === true;
}

function errorParams(params: Json, stream: boolean): Json {
  return { ...Records.clone(params), stream };
}

function withSession(payload: Json, sessionId: string): void {
  if (sessionId) payload._sessionId = sessionId;
}

function reasoningDisabled(body: Json): boolean {
  if (typeof body.include_thoughts === "boolean") return !body.include_thoughts;
  const effort = Coerce.string(body.reasoning_effort).trim().toLowerCase();
  if (effort) return effort === "none";
  const reasoning = body.reasoning;
  if (reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning)) {
    const record = reasoning as Json;
    const include = record.include_thoughts ?? record.includeThoughts;
    if (typeof include === "boolean" && !include) return true;
    const nestedEffort = Coerce.string(record.effort).trim().toLowerCase();
    if (nestedEffort) return nestedEffort === "none";
  }
  return false;
}

function reasoningRequested(body: Json): boolean {
  if (reasoningDisabled(body)) return false;
  if (typeof body.include_thoughts === "boolean") return body.include_thoughts;
  if (Coerce.string(body.reasoning_effort)) return true;
  if (body.reasoning !== null && typeof body.reasoning === "object" && !Array.isArray(body.reasoning)) {
    return true;
  }
  return body.thinking_budget !== undefined && body.thinking_budget !== null;
}

export abstract class Adapter {
  abstract readonly endpoint: string;

  abstract readonly format: ErrorFormat;

  abstract readonly rateLimitStatus: number;

  abstract readonly noAccountsStatus: number;

  abstract handleStream(ctx: ResponseContext, recorder: StreamRecorder): Promise<Response>;

  abstract handleNonStream(ctx: ResponseContext, recorder: StreamRecorder): Promise<Response>;

  parse(body: Json): ParsedEndpointRequest | RouteError {
    const parsedModel = requiredModel(body);
    if (!("model" in parsedModel)) return parsedModel;
    return this.toParsed(body, parsedModel.model);
  }

  build(parsed: ParsedEndpointRequest, model: string, stream: boolean, sessionId: string): Json {
    const payload = this.toPayload(parsed, model, stream);
    withSession(payload, sessionId);
    return payload;
  }

  protected abstract toParsed(body: Json, model: string): ParsedEndpointRequest | RouteError;

  protected abstract toPayload(parsed: ParsedEndpointRequest, model: string, stream: boolean): Json;
}

export class Chat extends Adapter {
  readonly endpoint = "chat_completions";

  readonly format: ErrorFormat = "openai";

  readonly rateLimitStatus = 429;

  readonly noAccountsStatus = 503;

  readonly handleStream = passthroughStream;

  readonly handleNonStream = passthrough;

  protected toParsed(body: Json, model: string): ParsedEndpointRequest | RouteError {
    if (!Array.isArray(body.messages)) {
      return { status: 400, message: "messages array is required", type: "invalid_request_error" };
    }
    const stream = streamParam(body);
    const params = Records.omit(body, "model", "messages", "stream");
    return {
      modelParam: model,
      stream,
      forcedAccountId: null,
      reasoningRequested: reasoningRequested(body),
      messagesForError: body.messages,
      paramsForError: errorParams(params, stream),
      routeData: { messages: body.messages, params },
    };
  }

  protected toPayload(parsed: ParsedEndpointRequest, model: string, stream: boolean): Json {
    const params = (parsed.routeData.params ?? {}) as Json;
    const body: Json = Records.clone(params);
    body.model = model;
    body.messages = parsed.routeData.messages;
    body.stream = stream;
    body._includeReasoning = parsed.reasoningRequested;
    return body;
  }
}

export class Messages extends Adapter {
  readonly endpoint = "messages";

  readonly format: ErrorFormat = "anthropic";

  readonly rateLimitStatus = 529;

  readonly noAccountsStatus = 529;

  readonly handleStream = anthropicStream;

  readonly handleNonStream = nonStream;

  protected toParsed(body: Json, model: string): ParsedEndpointRequest | RouteError {
    const stream = streamParam(body);
    const params = Records.omit(body, "model", "messages", "stream");
    params.stream = stream;
    return {
      modelParam: model,
      stream,
      forcedAccountId: null,
      reasoningRequested: false,
      messagesForError: body.messages,
      paramsForError: params,
      routeData: { body },
    };
  }

  protected toPayload(parsed: ParsedEndpointRequest, model: string, stream: boolean): Json {
    const body = (parsed.routeData.body ?? {}) as Json;
    const payload = toChat(body);
    payload.model = model;
    payload.stream = stream;
    return payload;
  }
}

export class Responses extends Adapter {
  readonly endpoint = "responses";

  readonly format: ErrorFormat = "openai";

  readonly rateLimitStatus = 429;

  readonly noAccountsStatus = 503;

  readonly handleStream = passthroughStream;

  readonly handleNonStream = passthrough;

  protected toParsed(body: Json, model: string): ParsedEndpointRequest | RouteError {
    if (!Array.isArray(body.input)) {
      return { status: 400, message: "input array is required", type: "invalid_request_error" };
    }
    const stream = streamParam(body);
    const instructions = Coerce.string(body.instructions);
    const messages = toMessages(body.input, instructions);
    const params = Records.omit(body, "model", "input", "instructions", "stream");
    if (params.max_output_tokens !== undefined) {
      params.max_tokens = params.max_output_tokens;
      delete params.max_output_tokens;
    }
    const sanitized = errorParams(params, stream);
    if (instructions) sanitized.instructions = instructions;
    return {
      modelParam: model,
      stream,
      forcedAccountId: null,
      reasoningRequested: reasoningRequested(params),
      messagesForError: messages,
      paramsForError: sanitized,
      routeData: { messages, responsesInput: body.input, instructions, params },
    };
  }

  protected toPayload(parsed: ParsedEndpointRequest, model: string, stream: boolean): Json {
    const params = (parsed.routeData.params ?? {}) as Json;
    const body: Json = Records.clone(params);
    body.model = model;
    body.messages = parsed.routeData.messages;
    if (Array.isArray(body.tools)) body.tools = toolsOf(body.tools);
    body.stream = stream;
    body._includeReasoning = parsed.reasoningRequested;
    body._responsesInput = parsed.routeData.responsesInput;
    const instructions = parsed.routeData.instructions;
    if (typeof instructions === "string" && instructions) body.instructions = instructions;
    return body;
  }
}

export function adapters(): Record<string, Adapter> {
  return {
    chat_completions: new Chat(),
    messages: new Messages(),
    responses: new Responses(),
  };
}

export { fromChat as transformOpenAIToAnthropic, toChat as transformAnthropicToOpenAI };
