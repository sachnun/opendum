import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildRequestBody,
  convertScenarioMessagesToAnthropic,
  extractChatCompletionData,
  formatDurationMs,
  getEndpointPath,
  getErrorMessageFromText,
  normalizeTokenValue,
  parseAdditionalParameters,
} from "./playground-protocol.ts";

const settings = {
  endpoint: "chat_completions" as const,
  streamResponses: true,
  temperature: 1,
  topP: 1,
  maxTokens: 4096,
  presencePenalty: 0,
  frequencyPenalty: 0,
  reasoningEffort: "none" as const,
};

describe("playground helpers", () => {
  it("parses additional parameters", () => {
    assert.deepEqual(parseAdditionalParameters(""), { params: null, error: "" });
    assert.deepEqual(parseAdditionalParameters('{"a":1}'), { params: { a: 1 }, error: "" });
    assert.ok(parseAdditionalParameters('{"a":').error.length > 0);
  });

  it("extracts an error message from text", () => {
    assert.equal(getErrorMessageFromText('{"error":{"message":"boom"}}'), "boom");
    assert.equal(getErrorMessageFromText('{"message":"plain"}'), "plain");
    assert.equal(getErrorMessageFromText("nope"), "nope");
  });

  it("extracts chat completion data", () => {
    const result = extractChatCompletionData({
      choices: [{ message: { content: "hi", reasoning_content: "why", tool_calls: [{ function: { name: "f", arguments: '{"x":1}' } }] } }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    assert.equal(result.content, "hi");
    assert.equal(result.reasoning, "why");
    assert.deepEqual(result.toolCalls, [{ name: "f", arguments: '{"x":1}' }]);
    assert.deepEqual(result.usage, { inputTokens: 1, outputTokens: 2, totalTokens: 3 });
  });

  it("builds a chat completions request body", () => {
    const body = buildRequestBody("m", [{ role: "user", content: "hi" }], settings);
    assert.equal(body.model, "m");
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, 4096);
  });

  it("converts scenario messages to anthropic", () => {
    const result = convertScenarioMessagesToAnthropic([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
    assert.equal(result.system, "sys");
    assert.deepEqual(result.messages, [{ role: "user", content: "hi" }]);
  });

  it("formats durations and tokens", () => {
    assert.equal(formatDurationMs(500), "500 ms");
    assert.equal(formatDurationMs(1500), "1.5 s");
    assert.equal(formatDurationMs(20000), "20 s");
    assert.equal(formatDurationMs(null), "-");
    assert.equal(normalizeTokenValue("x"), null);
    assert.equal(normalizeTokenValue(5.6), 6);
  });

  it("maps endpoints to paths", () => {
    assert.equal(getEndpointPath("messages"), "/v1/messages");
    assert.equal(getEndpointPath("responses"), "/v1/responses");
    assert.equal(getEndpointPath("chat_completions"), "/v1/chat/completions");
  });
});
