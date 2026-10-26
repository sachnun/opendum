import { describe, expect, it } from "bun:test";

import {
  Body,
  Completion,
  Duration,
  ErrorText,
  Params,
  Tokens,
} from "~~/lib/playground-protocol";

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
    expect(Params.parse("")).toEqual({ params: null, error: "" });
    expect(Params.parse('{"a":1}')).toEqual({ params: { a: 1 }, error: "" });
    expect(Params.parse('{"a":').error.length > 0).toBeTruthy();
  });

  it("extracts an error message from text", () => {
    expect(ErrorText.fromResponse('{"error":{"message":"boom"}}')).toBe("boom");
    expect(ErrorText.fromResponse('{"message":"plain"}')).toBe("plain");
    expect(ErrorText.fromResponse("nope")).toBe("nope");
  });

  it("extracts chat completion data", () => {
    const result = Completion.chat({
      choices: [{ message: { content: "hi", reasoning_content: "why", tool_calls: [{ function: { name: "f", arguments: '{"x":1}' } }] } }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    expect(result.content).toBe("hi");
    expect(result.reasoning).toBe("why");
    expect(result.toolCalls).toEqual([{ name: "f", arguments: '{"x":1}' }]);
    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
  });

  it("builds a chat completions request body", () => {
    const body = Body.build("m", [{ role: "user", content: "hi" }], settings);
    expect(body.model).toBe("m");
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(4096);
  });

  it("converts scenario messages to anthropic", () => {
    const result = Body.anthropicMessages([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
    expect(result.system).toBe("sys");
    expect(result.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("formats durations and tokens", () => {
    expect(Duration.format(500)).toBe("500 ms");
    expect(Duration.format(1500)).toBe("1.5 s");
    expect(Duration.format(20000)).toBe("20 s");
    expect(Duration.format(null)).toBe("-");
    expect(Tokens.value("x")).toBe(null);
    expect(Tokens.value(5.6)).toBe(6);
  });

  it("maps endpoints to paths", () => {
    expect(ErrorText.path("messages")).toBe("/v1/messages");
    expect(ErrorText.path("responses")).toBe("/v1/responses");
    expect(ErrorText.path("chat_completions")).toBe("/v1/chat/completions");
  });
});
