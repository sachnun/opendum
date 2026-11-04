import { describe, expect, it } from "bun:test";

import {
  Body,
  Completion,
  Duration,
  ErrorText,
  Params,
  Sse,
  Tokens,
  ToolCalls,
} from "~/lib/playground-protocol";

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

describe("playground request building", () => {
  it("parses additional parameters", () => {
    expect(Params.parse("")).toEqual({ params: null, error: "" });
    expect(Params.parse('{"a":1}')).toEqual({ params: { a: 1 }, error: "" });
    expect(Params.parse('{"a":').error.length > 0).toBeTruthy();
    expect(Params.parse("[1]").error.length > 0).toBeTruthy();
  });

  it("clamps numeric parameters", () => {
    expect(Params.clamp(5, 0, 2)).toBe(2);
    expect(Params.clamp(-5, 0, 2)).toBe(0);
    expect(Params.clamp(1.5, 0, 2)).toBe(1.5);
  });

  it("builds a chat completions request body", () => {
    const body = Body.build("m", [{ role: "user", content: "hi" }], settings);
    expect(body.model).toBe("m");
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(4096);
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("builds a responses request body", () => {
    const body = Body.build("m", [{ role: "user", content: "hi" }], { ...settings, endpoint: "responses" });
    expect(body.max_output_tokens).toBe(4096);
    expect(body.max_tokens).toBeUndefined();
    expect(body.input).toEqual([{ type: "message", role: "user", content: "hi" }]);
  });

  it("adds reasoning budget for anthropic when effort is set", () => {
    const body = Body.build("claude", [{ role: "user", content: "hi" }], {
      ...settings,
      endpoint: "messages",
      reasoningEffort: "low",
    });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 4000 });
  });

  it("uses adaptive thinking for opus 4.7", () => {
    const body = Body.build("claude-opus-4-7", [{ role: "user", content: "hi" }], {
      ...settings,
      endpoint: "messages",
      reasoningEffort: "high",
    });
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "high" });
  });

  it("converts scenario messages to anthropic", () => {
    const result = Body.anthropicMessages([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
    expect(result.system).toBe("sys");
    expect(result.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("maps image parts to anthropic image sources", () => {
    const result = Body.anthropicMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image_url", image_url: { url: "https://img" } },
        ],
      },
    ]);
    expect(result.messages[0]?.content).toEqual([
      { type: "text", text: "describe" },
      { type: "image", source: { type: "url", url: "https://img" } },
    ]);
  });

  it("prefixes the model with the provider or account selector", () => {
    const byProvider: Record<string, unknown> = { model: "claude" };
    Body.route(byProvider, "anthropic", null);
    expect(byProvider.model).toBe("anthropic/claude");

    const byAccount: Record<string, unknown> = { model: "claude" };
    Body.route(byAccount, "anthropic", "account-1");
    expect(byAccount.model).toBe("account-1/claude");

    const untouched: Record<string, unknown> = { model: "claude" };
    Body.route(untouched, null, null);
    expect(untouched.model).toBe("claude");
  });

  it("does not double-prefix an already routed model", () => {
    const body: Record<string, unknown> = { model: "anthropic/claude" };
    Body.route(body, "anthropic", null);
    expect(body.model).toBe("anthropic/claude");
  });

  it("adapts tool overrides for the anthropic endpoint", () => {
    const overrides = Body.overrides(
      {
        stream: false,
        tool_choice: "auto",
        tools: [
          {
            type: "function",
            function: { name: "get_weather", description: "weather", parameters: { type: "object" } },
          },
        ],
      },
      "messages"
    );

    expect(overrides?.stream).toBe(false);
    expect(overrides?.tool_choice).toEqual({ type: "auto" });
    expect(overrides?.tools).toEqual([
      { name: "get_weather", description: "weather", input_schema: { type: "object" } },
    ]);
  });

  it("leaves overrides untouched for non-anthropic endpoints", () => {
    const overrides = { stream: false, tool_choice: "auto" };
    expect(Body.overrides(overrides, "chat_completions")).toBe(overrides);
    expect(Body.overrides(undefined, "messages")).toBeNull();
  });
});

describe("playground response parsing", () => {
  it("extracts chat completion data", () => {
    const result = Completion.chat({
      choices: [
        {
          message: {
            content: "hi",
            reasoning_content: "why",
            tool_calls: [{ function: { name: "f", arguments: '{"x":1}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    expect(result.content).toBe("hi");
    expect(result.reasoning).toBe("why");
    expect(result.toolCalls).toEqual([{ name: "f", arguments: '{"x":1}' }]);
    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
  });

  it("extracts anthropic content blocks", () => {
    const result = Completion.anthropic({
      content: [
        { type: "text", text: "hello" },
        { type: "thinking", thinking: "hmm" },
        { type: "tool_use", name: "search", input: { q: "x" } },
      ],
    });
    expect(result.content).toBe("hello");
    expect(result.reasoning).toBe("hmm");
    expect(result.toolCalls).toEqual([{ name: "search", arguments: '{"q":"x"}' }]);
  });

  it("extracts responses output items", () => {
    const result = Completion.responses({
      output: [
        { type: "message", content: [{ type: "output_text", text: "answer" }] },
        { type: "reasoning", summary: [{ text: "thought" }] },
        { type: "function_call", name: "lookup", arguments: '{"id":1}' },
      ],
    });
    expect(result.content).toBe("answer");
    expect(result.reasoning).toBe("thought");
    expect(result.toolCalls).toEqual([{ name: "lookup", arguments: '{"id":1}' }]);
  });

  it("detects provider errors in payloads", () => {
    expect(Completion.error({ error: { message: "boom" } })).toBe("boom");
    expect(Completion.error({ error: { message: "   " } })).toBeNull();
    expect(Completion.error({})).toBeNull();
    expect(Completion.error(null)).toBeNull();
  });

  it("parses anthropic streaming deltas", () => {
    expect(Completion.anthropicStream("content_block_delta", { delta: { type: "text_delta", text: "a" } }).content).toBe("a");
    expect(
      Completion.anthropicStream("content_block_delta", { delta: { type: "thinking_delta", thinking: "b" } }).reasoning
    ).toBe("b");
    expect(Completion.anthropicStream("message_delta", { usage: { output_tokens: 3 } }).usage).toEqual({
      inputTokens: null,
      outputTokens: 3,
      totalTokens: null,
    });
  });

  it("parses responses streaming events", () => {
    expect(Completion.responsesStream({ type: "response.output_text.delta", delta: "x" }).content).toBe("x");
    expect(Completion.responsesStream({ type: "response.reasoning.delta", delta: "y" }).reasoning).toBe("y");
    expect(Completion.responsesStream({ type: "response.completed", usage: { total_tokens: 9 } }).usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: 9,
    });
  });

  it("normalizes and merges token usage", () => {
    expect(Tokens.value("x")).toBeNull();
    expect(Tokens.value(5.6)).toBe(6);
    expect(Tokens.usage({ usage: { input_tokens: 2, output_tokens: 3 } })).toEqual({
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: null,
    });
    expect(
      Tokens.merge({ inputTokens: 2, outputTokens: null, totalTokens: null }, { inputTokens: null, outputTokens: 5, totalTokens: null })
    ).toEqual({ inputTokens: 2, outputTokens: 5, totalTokens: null });
    expect(Tokens.metrics(10, 20, { inputTokens: 1, outputTokens: 2, totalTokens: null })).toEqual({
      waitMs: 10,
      firstResponseMs: 20,
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
    });
  });

  it("falls back to placeholder names for malformed tool calls", () => {
    expect(ToolCalls.extract([null, { function: {} }])).toEqual([
      { name: "tool_1", arguments: "{}" },
      { name: "tool_2", arguments: "{}" },
    ]);
  });

  it("pretty-prints tool call arguments", () => {
    expect(ToolCalls.format('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(ToolCalls.format("not json")).toBe("not json");
  });

  it("feeds SSE chunks through the processor", () => {
    const chunks: string[] = [];
    const processor = Sse.processor("chat_completions", (chunk) => chunks.push(chunk.content));

    processor.feed('data: {"choices":[{"delta":{"content":"he"}}]}\n\n');
    processor.feed('data: {"choices":[{"delta":{"content":"llo"}}]}\n\ndata: [DONE]\n\n');

    expect(chunks).toEqual(["he", "llo"]);
  });

  it("raises on provider errors inside SSE payloads", () => {
    const processor = Sse.processor("chat_completions", () => undefined);
    expect(() => processor.feed('data: {"error":{"message":"boom"}}\n\n')).toThrow("boom");
  });
});

describe("playground error formatting", () => {
  it("extracts an error message from text", () => {
    expect(ErrorText.fromResponse('{"error":{"message":"boom"}}')).toBe("boom");
    expect(ErrorText.fromResponse('{"message":"plain"}')).toBe("plain");
    expect(ErrorText.fromResponse("nope")).toBe("nope");
    expect(ErrorText.fromResponse("  ")).toBe("Request failed");
  });

  it("truncates long values", () => {
    expect(ErrorText.truncate("short")).toBe("short");
    const truncated = ErrorText.truncate("x".repeat(300));
    expect(truncated.startsWith("x".repeat(200))).toBe(true);
    expect(truncated).toContain("truncated");
  });

  it("summarizes tool definitions", () => {
    expect(ErrorText.summarizeTools([{ function: { name: "a" } }, { name: "b" }])).toBe("[2 tool(s): a, b]");
  });

  it("redacts message bodies in parameters", () => {
    const sanitized = ErrorText.parameters({ messages: [1, 2], model: "m" });
    expect(sanitized.messages).toBe('[redacted: see "Messages (object keys only)"]');
    expect(sanitized.model).toBe("m");
  });

  it("summarizes message object keys", () => {
    const summary = ErrorText.summarizeMessages([{ role: "user", content: "hi" }, "raw"]);
    expect(summary).toContain('"keys"');
    expect(summary).toContain('"type": "string"');
  });

  it("maps endpoints to paths", () => {
    expect(ErrorText.path("messages")).toBe("/v1/messages");
    expect(ErrorText.path("responses")).toBe("/v1/responses");
    expect(ErrorText.path("chat_completions")).toBe("/v1/chat/completions");
  });

  it("builds a readable error report", () => {
    const report = ErrorText.build("boom", {
      model: "m",
      provider: "anthropic",
      endpoint: "messages",
      parameters: { model: "m" },
      messages: [{ role: "user", content: "hi" }],
    });

    expect(report).toContain("Error: boom");
    expect(report).toContain("Provider: anthropic");
    expect(report).toContain("Endpoint: /v1/messages");
    expect(report).toContain("Model: m");
    expect(report).toContain("Messages (object keys only):");
  });

  it("formats durations", () => {
    expect(Duration.format(500)).toBe("500 ms");
    expect(Duration.format(1500)).toBe("1.5 s");
    expect(Duration.format(20000)).toBe("20 s");
    expect(Duration.format(null)).toBe("-");
    expect(Duration.format(-1)).toBe("-");
  });
});
