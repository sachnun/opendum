import { Schema } from "effect";
import type { IrEvent, IrRequest, IrResponse } from "@opendum/protocol/ir";
import {
  ChatStreamDecoder,
  ChatStreamEncoder,
  decodeRequest as decodeChatRequest,
  decodeResponse as decodeChatResponse,
  encodeRequest as encodeChatRequest,
  encodeResponse as encodeChatResponse,
} from "@opendum/protocol/openai/chat-codec";
import {
  decodeRequest as decodeResponsesRequest,
  encodeRequest as encodeResponsesRequest,
  decodeResponse as decodeResponsesResponse,
  encodeResponse as encodeResponsesResponse,
  ResponsesStreamDecoder,
  ResponsesStreamEncoder,
} from "@opendum/protocol/openai/responses-codec";
import {
  AnthropicStreamDecoder,
  AnthropicStreamEncoder,
  decodeRequest as decodeAnthropicRequest,
  decodeResponse as decodeAnthropicResponse,
  encodeRequest as encodeAnthropicRequest,
  encodeResponse as encodeAnthropicResponse,
} from "@opendum/protocol/anthropic/codec";

export const Dialect = Schema.Literals(["chat", "responses", "messages"]);

export type Dialect = typeof Dialect.Type;

export type StreamEvent = { event: string; data: string };

export function decodeRequest(dialect: Dialect, body: unknown): IrRequest {
  switch (dialect) {
    case "chat":
      return decodeChatRequest(body);
    case "responses":
      return decodeResponsesRequest(body);
    case "messages":
      return decodeAnthropicRequest(body);
    default:
      return decodeChatRequest(body);
  }
}

export function encodeRequest(dialect: Dialect, request: IrRequest): Record<string, unknown> {
  switch (dialect) {
    case "chat":
      return encodeChatRequest(request);
    case "responses":
      return encodeResponsesRequest(request);
    case "messages":
      return encodeAnthropicRequest(request);
    default:
      return encodeChatRequest(request);
  }
}

export function decodeResponse(dialect: Dialect, body: unknown, model: string): IrResponse {
  switch (dialect) {
    case "chat":
      return decodeChatResponse(body, model);
    case "responses":
      return decodeResponsesResponse(body, model);
    case "messages":
      return decodeAnthropicResponse(body, model);
    default:
      return decodeChatResponse(body, model);
  }
}

export function encodeResponse(
  dialect: Dialect,
  response: IrResponse
): Record<string, unknown> {
  switch (dialect) {
    case "chat":
      return encodeChatResponse(response);
    case "responses":
      return encodeResponsesResponse(response);
    case "messages":
      return encodeAnthropicResponse(response);
    default:
      return encodeChatResponse(response);
  }
}

export interface StreamCodec {
  decode(event: StreamEvent): ReadonlyArray<IrEvent>;
  finish(): IrEvent;
}

export interface StreamEncoder {
  encode(event: IrEvent): ReadonlyArray<StreamEvent>;
}

export function streamDecoder(dialect: Dialect, model: string): StreamCodec {
  switch (dialect) {
    case "chat":
      return new ChatStreamDecoder(model);
    case "responses":
      return new ResponsesStreamDecoder(model);
    case "messages":
      return new AnthropicStreamDecoder(model);
    default:
      return new ChatStreamDecoder(model);
  }
}

export function streamEncoder(dialect: Dialect): StreamEncoder {
  switch (dialect) {
    case "chat":
      return new ChatStreamEncoder();
    case "responses":
      return new ResponsesStreamEncoder();
    case "messages":
      return new AnthropicStreamEncoder();
    default:
      return new ChatStreamEncoder();
  }
}
