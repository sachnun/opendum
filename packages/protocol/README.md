# @opendum/protocol

Wire-level types and codecs for the three inference dialects Opendum exposes:

| Dialect | Module | Spec |
|---|---|---|
| `chat` | `openai/chat.ts` | OpenAI Chat Completions |
| `responses` | `openai/responses.ts` | OpenAI Responses |
| `messages` | `anthropic/messages.ts` | Anthropic Messages |

Every dialect is described twice: as a runtime `Schema` and as an exported type
derived from that schema. Field names, literal unions, optionality, and
nullability follow the upstream specs.

## Layers

```
wire types        openai/chat.ts · openai/responses.ts · anthropic/messages.ts
   ↓ codec
internal IR       ir.ts
   ↓ codec
wire types        same modules, encoder side
```

`ir.ts` is the only shape the proxy and providers share. A dialect never talks
to another dialect directly; both go through the IR.

| IR piece | Purpose |
|---|---|
| `IrRequest` | model, messages, tools, sampling, reasoning, stream, metadata |
| `IrContent` | `text`, `image`, `tool_call`, `tool_result`, `reasoning` |
| `IrResponse` | content, finish reason, usage, status |
| `IrEvent` | `start`, `reasoning_delta`, `text_delta`, `tool_start`, `tool_args_delta`, `finish`, `error` |
| `IrUsage` | input, output, cached, cache write, reasoning tokens |

`reasoning` is the only representation inside the IR. Each dialect maps its own
form onto it:

| Dialect | Request side | Response side |
|---|---|---|
| chat | `reasoning_effort`, `reasoning.effort`, `thinking_budget` | `reasoning_content` |
| responses | `reasoning.effort`, `include: ["reasoning.encrypted_content"]` | `reasoning` item + `summary` |
| messages | `thinking.{type,budget_tokens}`, `output_config.effort` | `thinking` block + `signature` |

Reasoning effort is translated across dialects, so an Anthropic client that
sends `thinking: { type: "adaptive" }` reaches an effort-based provider, and a
Chat client that sends `reasoning_effort: "high"` reaches an Anthropic provider
as a thinking budget clamped below `max_tokens`.

## Modules

| Module | Responsibility |
|---|---|
| `ir.ts` | IR types and schemas, `emptyUsage`, `textOf`, `toolCallsOf` |
| `sse.ts` | One SSE decoder, reader, and formatter for the whole repo |
| `usage.ts` | `IrUsage` mapping to and from all three dialects |
| `openai/chat.ts`, `openai/responses.ts`, `anthropic/messages.ts` | Wire types |
| `openai/chat-codec.ts`, `openai/responses-codec.ts`, `anthropic/codec.ts` | Request, response, and stream codecs |
| `upstream.ts` | Dialect dispatch: `decodeRequest`, `encodeRequest`, `decodeResponse`, `encodeResponse`, `streamDecoder`, `streamEncoder` |
| `stream.ts` | `upstreamEvents`, `encodeEvents`, `UsageCollector` |

## Adding a provider

A provider only declares its dialect and its quirks. It never writes its own
translation.

```ts
import type { Dialect } from "@opendum/protocol/upstream";

export const definition = {
  name: "example",
  dialect: "chat" satisfies Dialect,
  baseUrl: "https://example.test/v1",
  supportedParams: new Set(["model", "messages", "temperature", "max_tokens", "stream", "tools"]),
  quirks: {
    responsesApi: (model: string) => model.startsWith("o"),
  },
};
```

| Need | Use |
|---|---|
| Request is chat-shaped | `encodeRequest("chat", ir)` |
| Request is responses-shaped | `encodeRequest("responses", ir)` |
| Request is anthropic-shaped | `encodeRequest("messages", ir)` |
| Upstream returns chat chunks | `streamDecoder("chat", model)` |
| Upstream returns responses events | `streamDecoder("responses", model)` |
| Upstream returns anthropic events | `streamDecoder("messages", model)` |
| Normalize a non-stream response | `decodeResponse(dialect, body, model)` |

## Stream pipeline

```
upstream bytes
  → SseReader
  → streamDecoder(dialect)        → IrEvent
  → streamEncoder(dialect)        → downstream events
```

`IrEvent` is the only stream vocabulary. A new dialect adds one decoder and one
encoder; nothing else changes.

## Endpoint wiring in the proxy

| Route | Request in | Upstream | Response out |
|---|---|---|---|
| `/v1/chat/completions` | chat | chat | passthrough |
| `/v1/messages` | messages | chat | messages |
| `/v1/responses` | responses | chat | responses |

The two converted routes run through `apps/api/core/protocol.ts` for the request
and `apps/api/core/protocol-stream.ts` for the response.

## Tests

```bash
bun test packages/protocol
```

The suite covers request normalization, response conversion, cross-dialect
round trips, SSE framing, usage mapping, and stream conversion in both
directions.
