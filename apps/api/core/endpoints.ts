import { Coerce, Records } from "@opendum/api/core/helpers";
import type { ErrorFormat, ParsedEndpointRequest, ResponseContext, RouteError, StreamRecorder } from "@opendum/api/core/types";
import { passthrough, passthroughStream } from "@opendum/api/core/stream";
import { protocolResponse, protocolStream } from "@opendum/api/core/protocol-stream";
import { chatPayload, messagesPayload, irOf, responsesPayload } from "@opendum/api/core/protocol";
import type { Dialect } from "@opendum/protocol/upstream";

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
    const request = irOf("chat", body);
    return {
      modelParam: model,
      stream,
      forcedAccountId: null,
      reasoningRequested: request.reasoning !== undefined && request.reasoning.mode !== "off",
      messagesForError: body.messages,
      paramsForError: errorParams(params, stream),
      routeData: { body },
    };
  }

  protected toPayload(parsed: ParsedEndpointRequest, model: string, stream: boolean): Json {
    const body = (parsed.routeData.body ?? {}) as Json;
    return chatPayload(irOf("chat", body), model, stream);
  }
}

export class Messages extends Adapter {
  readonly endpoint = "messages";

  readonly format: ErrorFormat = "anthropic";

  readonly rateLimitStatus = 529;

  readonly noAccountsStatus = 529;

  readonly handleStream = protocolMessagesStream;

  readonly handleNonStream = protocolMessagesResponse;

  protected toParsed(body: Json, model: string): ParsedEndpointRequest | RouteError {
    const stream = streamParam(body);
    const params = Records.omit(body, "model", "messages", "stream");
    params.stream = stream;
    const request = irOf("messages", body);
    return {
      modelParam: model,
      stream,
      forcedAccountId: null,
      reasoningRequested: request.reasoning !== undefined && request.reasoning.mode !== "off",
      messagesForError: body.messages,
      paramsForError: params,
      routeData: { body },
    };
  }

  protected toPayload(parsed: ParsedEndpointRequest, model: string, stream: boolean): Json {
    const body = (parsed.routeData.body ?? {}) as Json;
    return messagesPayload(body, model, stream);
  }
}

export class Responses extends Adapter {
  readonly endpoint = "responses";

  readonly format: ErrorFormat = "openai";

  readonly rateLimitStatus = 429;

  readonly noAccountsStatus = 503;

  readonly handleStream = protocolResponsesStream;

  readonly handleNonStream = protocolResponsesResponse;

  protected toParsed(body: Json, model: string): ParsedEndpointRequest | RouteError {
    if (!Array.isArray(body.input)) {
      return { status: 400, message: "input array is required", type: "invalid_request_error" };
    }
    const stream = streamParam(body);
    const instructions = Coerce.string(body.instructions);
    const request = irOf("responses", body);
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
      reasoningRequested: request.reasoning !== undefined && request.reasoning.mode !== "off",
      messagesForError: request.messages,
      paramsForError: sanitized,
      routeData: { body, instructions },
    };
  }

  protected toPayload(parsed: ParsedEndpointRequest, model: string, stream: boolean): Json {
    const body = (parsed.routeData.body ?? {}) as Json;
    return responsesPayload(body, model, stream);
  }
}

function dialectFor(target: Dialect): { from: Dialect; to: Dialect } {
  return { from: "chat", to: target };
}

function protocolMessagesStream(ctx: ResponseContext, recorder: StreamRecorder): Promise<Response> {
  return protocolStream(ctx, recorder, { ...dialectFor("messages"), model: ctx.model });
}

function protocolMessagesResponse(ctx: ResponseContext, recorder: StreamRecorder): Promise<Response> {
  return protocolResponse(ctx, recorder, { ...dialectFor("messages"), model: ctx.model });
}

function protocolResponsesStream(ctx: ResponseContext, recorder: StreamRecorder): Promise<Response> {
  return protocolStream(ctx, recorder, { ...dialectFor("responses"), model: ctx.model });
}

function protocolResponsesResponse(ctx: ResponseContext, recorder: StreamRecorder): Promise<Response> {
  return protocolResponse(ctx, recorder, { ...dialectFor("responses"), model: ctx.model });
}

export function adapters(): Record<string, Adapter> {
  return {
    chat_completions: new Chat(),
    messages: new Messages(),
    responses: new Responses(),
  };
}
