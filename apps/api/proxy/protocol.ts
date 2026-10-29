import { emptyUsage, type IrEvent, type IrRequest } from "@opendum/protocol/ir";
import { decodeRequest, encodeRequest, type Dialect } from "@opendum/protocol/upstream";

type Json = Record<string, unknown>;

const DEFAULT_MAX_TOKENS = 4096;

export function irOf(dialect: Dialect, body: Json): IrRequest {
  return decodeRequest(dialect, body);
}

export function chatPayload(request: IrRequest, model: string, stream: boolean): Json {
  const payload = encodeRequest("chat", request);
  payload.model = model;
  payload.stream = stream;
  payload._includeReasoning = request.reasoning !== undefined && request.reasoning.mode !== "off";
  return payload;
}

export function messagesPayload(body: Json, model: string, stream: boolean): Json {
  const request = irOf("messages", body);
  const payload = chatPayload(request, model, stream);
  if (request.sampling.maxTokens === undefined) payload.max_tokens = DEFAULT_MAX_TOKENS;
  return payload;
}

export function responsesPayload(body: Json, model: string, stream: boolean): Json {
  const request = irOf("responses", body);
  const payload = chatPayload(request, model, stream);
  payload._responsesInput = body.input;
  const instructions = typeof body.instructions === "string" ? body.instructions : "";
  if (instructions) payload.instructions = instructions;
  return payload;
}

export function reasoningRequested(dialect: Dialect, body: Json): boolean {
  const request = irOf(dialect, body);
  return request.reasoning !== undefined && request.reasoning.mode !== "off";
}

export function usageOfEvents(events: ReadonlyArray<IrEvent>): typeof emptyUsage extends () => infer T ? T : never {
  let usage = emptyUsage();
  for (const event of events) {
    if (event.type !== "finish") continue;
    usage = event.usage;
  }
  return usage;
}

export type { Dialect, IrEvent, IrRequest };
