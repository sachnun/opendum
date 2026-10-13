import { describe, expect, it } from "bun:test";

import {
  buildRequestBody,
  convertScenarioMessagesToAnthropic,
  extractChatCompletionData,
  formatDurationMs,
  getEndpointPath,
  getErrorMessageFromText,
  normalizeTokenValue,
  parseAdditionalParameters,
} from "./playground-protocol";

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
    expect(parseAdditionalParameters("")).toEqual({ params: null, error: "" });
    expect(parseAdditionalParameters('{"a":1}')).toEqual({ params: { a: 1 }, error: "" });
    expect(parseAdditionalParameters('{"a":').error.length > 0).toBeTruthy();
  });

  it("extracts an error message from text", () => {
    expect(getErrorMessageFromText('{"error":{"message":"boom"}}')).toBe("boom");
    expect(getErrorMessageFromText('{"message":"plain"}')).toBe("plain");
    expect(getErrorMessageFromText("nope")).toBe("nope");
  });

  it("extracts chat completion data", () => {
    const result = extractChatCompletionData({
      choices: [{ message: { content: "hi", reasoning_content: "why", tool_calls: [{ function: { name: "f", arguments: '{"x":1}' } }] } }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    expect(result.content).toBe("hi");
    expect(result.reasoning).toBe("why");
    expect(result.toolCalls).toEqual([{ name: "f", arguments: '{"x":1}' }]);
    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
  });

  it("builds a chat completions request body", () => {
    const body = buildRequestBody("m", [{ role: "user", content: "hi" }], settings);
    expect(body.model).toBe("m");
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(4096);
  });

  it("converts scenario messages to anthropic", () => {
    const result = convertScenarioMessagesToAnthropic([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
    expect(result.system).toBe("sys");
    expect(result.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("formats durations and tokens", () => {
    expect(formatDurationMs(500)).toBe("500 ms");
    expect(formatDurationMs(1500)).toBe("1.5 s");
    expect(formatDurationMs(20000)).toBe("20 s");
    expect(formatDurationMs(null)).toBe("-");
    expect(normalizeTokenValue("x")).toBe(null);
    expect(normalizeTokenValue(5.6)).toBe(6);
  });

  it("maps endpoints to paths", () => {
    expect(getEndpointPath("messages")).toBe("/v1/messages");
    expect(getEndpointPath("responses")).toBe("/v1/responses");
    expect(getEndpointPath("chat_completions")).toBe("/v1/chat/completions");
  });
});
