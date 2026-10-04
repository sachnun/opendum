import { assert, describe, it } from "vitest";
import { chatCompletionsConfig, messagesConfig, responsesConfig, transformAnthropicToOpenAI, transformOpenAIToAnthropic } from "../src/core/endpoints.js";
import { SseScanner } from "../src/core/sse.js";
import { isRouteError } from "../src/core/types.js";
import { retryMetadata, sanitizedProxyError, shouldRotate } from "../src/core/errors.js";

describe("chat completions parse", () => {
  it("rejects a missing model", () => {
    const parsed = chatCompletionsConfig().parse({ messages: [] });
    assert.isTrue(isRouteError(parsed));
    if (isRouteError(parsed)) assert.equal(parsed.status, 400);
  });

  it("rejects a missing messages array", () => {
    const parsed = chatCompletionsConfig().parse({ model: "gpt-4o" });
    assert.isTrue(isRouteError(parsed));
  });

  it("parses a valid request and builds a payload", () => {
    const parsed = chatCompletionsConfig().parse({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      reasoning_effort: "high",
    });
    assert.isFalse(isRouteError(parsed));
    if (isRouteError(parsed)) return;
    assert.equal(parsed.stream, true);
    assert.equal(parsed.reasoningRequested, true);
    const built = chatCompletionsConfig().build(parsed, "gpt-4o", true, "sess-1");
    assert.equal(built.model, "gpt-4o");
    assert.equal(built._sessionId, "sess-1");
    assert.equal(built._includeReasoning, true);
  });
});

describe("messages transform", () => {
  it("converts anthropic request to openai", () => {
    const parsed = messagesConfig().parse({
      model: "claude-sonnet-4-6",
      max_tokens: 128,
      system: "be nice",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });
    assert.isFalse(isRouteError(parsed));
    if (isRouteError(parsed)) return;
    const built = messagesConfig().build(parsed, "claude-sonnet-4-6", false, "");
    assert.equal(built.max_tokens, 128);
    const messages = built.messages as Array<Record<string, unknown>>;
    assert.equal(messages[0].role, "system");
    assert.equal(messages[0].content, "be nice");
    assert.equal(messages[1].content, "hello");
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
    assert.equal(response.type, "message");
    const content = response.content as Array<Record<string, unknown>>;
    assert.equal(content[0].type, "thinking");
    assert.equal(content[1].type, "text");
    assert.equal((response.usage as Record<string, number>).input_tokens, 5);
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
    assert.isUndefined(messages[0].tool_calls);
  });
});

describe("responses parse", () => {
  it("converts responses input into messages", () => {
    const parsed = responsesConfig().parse({
      model: "gpt-4o",
      input: [{ role: "user", content: [{ type: "input_text", text: "yo" }] }],
      max_output_tokens: 64,
    });
    assert.isFalse(isRouteError(parsed));
    if (isRouteError(parsed)) return;
    assert.equal(parsed.paramsForError.max_tokens, 64);
    const built = responsesConfig().build(parsed, "gpt-4o", false, "");
    assert.isArray(built._responsesInput);
    const messages = built.messages as Array<Record<string, unknown>>;
    assert.equal(messages[0].role, "user");
  });
});

describe("sse scanner", () => {
  it("parses split data events", () => {
    const scanner = new SseScanner();
    const events: string[] = [];
    scanner.process('data: {"a":1}\n\ndata: {"b', (event) => events.push(event.data));
    scanner.process(':2}\n\n', (event) => events.push(event.data));
    console.log(events);
    assert.deepEqual(events, ['{"a":1}', '{"b:2}']);
  });

  it("skips [DONE]", () => {
    const scanner = new SseScanner();
    const events: string[] = [];
    scanner.process("data: [DONE]\n\n", (event) => events.push(event.data));
    assert.deepEqual(events, []);
  });
});

describe("errors", () => {
  it("rotates on 5xx and 429", () => {
    assert.isTrue(shouldRotate(500));
    assert.isTrue(shouldRotate(429));
    assert.isFalse(shouldRotate(400));
  });

  it("extracts nested provider message", () => {
    const result = sanitizedProxyError(400, JSON.stringify({ error: { message: "bad  input" } }));
    assert.equal(result.message, "bad input");
    assert.equal(result.type, "invalid_request_error");
  });

  it("formats retry metadata", () => {
    const meta = retryMetadata(1500);
    assert.equal(meta.retryAfter, "2s");
    assert.equal(meta.retryAfterMs, 1500);
  });
});
