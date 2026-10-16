import { describe, expect, it } from "bun:test";
import { Chat, Messages, Responses, adapters, transformAnthropicToOpenAI, transformOpenAIToAnthropic } from "../core/endpoints.js";
import { SseScanner } from "../core/sse.js";
import { isRouteError } from "../core/types.js";
import { retryMetadata, sanitizedProxyError, shouldRotate } from "../core/errors.js";

describe("chat completions parse", () => {
  it("rejects a missing model", () => {
    const parsed = new Chat().parse({ messages: [] });
    expect(isRouteError(parsed)).toBe(true);
    if (isRouteError(parsed)) expect(parsed.status).toBe(400);
  });

  it("rejects a missing messages array", () => {
    const parsed = new Chat().parse({ model: "gpt-4o" });
    expect(isRouteError(parsed)).toBe(true);
  });

  it("parses a valid request and builds a payload", () => {
    const parsed = new Chat().parse({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      reasoning_effort: "high",
    });
    expect(isRouteError(parsed)).toBe(false);
    if (isRouteError(parsed)) return;
    expect(parsed.stream).toBe(true);
    expect(parsed.reasoningRequested).toBe(true);
    const built = new Chat().build(parsed, "gpt-4o", true, "sess-1");
    expect(built.model).toBe("gpt-4o");
    expect(built._sessionId).toBe("sess-1");
    expect(built._includeReasoning).toBe(true);
  });
});

describe("messages transform", () => {
  it("converts anthropic request to openai", () => {
    const parsed = new Messages().parse({
      model: "claude-sonnet-4-6",
      max_tokens: 128,
      system: "be nice",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });
    expect(isRouteError(parsed)).toBe(false);
    if (isRouteError(parsed)) return;
    const built = new Messages().build(parsed, "claude-sonnet-4-6", false, "");
    expect(built.max_tokens).toBe(128);
    const messages = built.messages as Array<Record<string, unknown>>;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toBe("be nice");
    expect(messages[1].content).toBe("hello");
  });

  it("converts openai completion to anthropic", () => {
    const response = transformOpenAIToAnthropic(
      {
        id: "abc",
        choices: [{ index: 0, message: { role: "assistant", content: "hi", reasoning_content: "why" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      },
      "claude"
    );
    expect(response.type).toBe("message");
    const content = response.content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe("thinking");
    expect(content[1].type).toBe("text");
    expect((response.usage as Record<string, number>).input_tokens).toBe(5);
  });

  it("drops orphaned tool_use blocks", () => {
    const payload = transformAnthropicToOpenAI({
      model: "claude",
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "orphan", name: "x", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "kept", content: "ok" }] },
      ],
    });
    const messages = payload.messages as Array<Record<string, unknown>>;
    expect(messages[0].tool_calls).toBeUndefined();
  });
});

describe("responses parse", () => {
  it("converts responses input into messages", () => {
    const parsed = new Responses().parse({
      model: "gpt-4o",
      input: [{ role: "user", content: [{ type: "input_text", text: "yo" }] }],
      max_output_tokens: 64,
    });
    expect(isRouteError(parsed)).toBe(false);
    if (isRouteError(parsed)) return;
    expect(parsed.paramsForError.max_tokens).toBe(64);
    const built = new Responses().build(parsed, "gpt-4o", false, "");
    expect(built._responsesInput).toBeArray();
    const messages = built.messages as Array<Record<string, unknown>>;
    expect(messages[0].role).toBe("user");
  });
});

describe("endpoint adapters", () => {
  it("exposes the three endpoints by name", () => {
    const map = adapters();
    expect(Object.keys(map).sort()).toEqual(["chat_completions", "messages", "responses"]);
    expect(map.chat_completions.endpoint).toBe("chat_completions");
    expect(map.messages.format).toBe("anthropic");
    expect(map.responses.noAccountsStatusCode).toBe(503);
  });
});

describe("sse scanner", () => {
  it("parses split data events", () => {
    const scanner = new SseScanner();
    const events: string[] = [];
    scanner.process('data: {"a":1}\n\ndata: {"b', (event) => events.push(event.data));
    scanner.process(':2}\n\n', (event) => events.push(event.data));
    expect(events).toEqual(['{"a":1}', '{"b:2}']);
  });

  it("skips [DONE]", () => {
    const scanner = new SseScanner();
    const events: string[] = [];
    scanner.process("data: [DONE]\n\n", (event) => events.push(event.data));
    expect(events).toEqual([]);
  });
});

describe("errors", () => {
  it("rotates on 5xx and 429", () => {
    expect(shouldRotate(500)).toBe(true);
    expect(shouldRotate(429)).toBe(true);
    expect(shouldRotate(400)).toBe(false);
  });

  it("extracts nested provider message", () => {
    const result = sanitizedProxyError(400, JSON.stringify({ error: { message: "bad  input" } }));
    expect(result.message).toBe("bad input");
    expect(result.type).toBe("invalid_request_error");
  });

  it("formats retry metadata", () => {
    const meta = retryMetadata(1500);
    expect(meta.retryAfter).toBe("2s");
    expect(meta.retryAfterMs).toBe(1500);
  });
});
