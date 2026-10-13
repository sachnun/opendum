import { describe, expect, it } from "bun:test";
import {
  chatCompletionToResponsesJson,
  chatSseToChatCompletion,
  convertToolsForResponses,
  messagesToResponsesInput,
  normalizeResponsesInput,
  responsesJsonToChatCompletion,
  clampPromptCacheKey,
  responsesUsageFromChat,
} from "./responses.js";
import { normalizeToolChoice } from "../core/helpers.js";
import { anthropicMessagesToChatCompletion, buildAnthropicMessagesPayload } from "./anthropic.js";

function streamOf(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

describe("responses transform", () => {
  it("converts chat messages to responses input", () => {
    const input = messagesToResponsesInput([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", function: { name: "do", arguments: '{"a":1}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
    ]) as Array<Record<string, unknown>>;
    expect(input[0].role).toBe("developer");
    expect(input[1].role).toBe("user");
    expect(input[2].type).toBe("function_call");
    expect(input[2].call_id).toBe("fc_1");
    expect(input[3].type).toBe("function_call_output");
  });

  it("normalizes shorthand responses input", () => {
    const input = normalizeResponsesInput([
      { role: "user", content: [{ type: "input_text", text: "hey" }] },
      { call_id: "fc_1", name: "do", arguments: "{}" },
    ]) as Array<Record<string, unknown>>;
    expect(input[0].type).toBe("message");
    expect(input[1].type).toBe("function_call");
  });

  it("converts chat tools to responses tools", () => {
    const tools = convertToolsForResponses([
      { type: "function", function: { name: "x", description: "d", parameters: { type: "object" } } },
    ]) as Array<Record<string, unknown>>;
    expect(tools[0].type).toBe("function");
    expect(tools[0].name).toBe("x");
  });

  it("normalizes function tool choice", () => {
    expect(normalizeToolChoice({ type: "function", function: { name: "x" } })).toEqual({ type: "function", name: "x" });
    expect(normalizeToolChoice("auto")).toBe("auto");
  });

  it("converts responses json to chat completion", () => {
    const completion = responsesJsonToChatCompletion(
      {
        status: "completed",
        output: [
          { type: "reasoning", summary: [{ type: "summary_text", text: "why" }] },
          { type: "message", content: [{ type: "output_text", text: "hello" }] },
          { type: "function_call", call_id: "fc_1", name: "do", arguments: "{}" },
        ],
        usage: { input_tokens: 3, output_tokens: 2 },
      },
      "gpt-4o"
    );
    const message = (completion.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>;
    expect(message.content).toBe("hello");
    expect(message.reasoning_content).toBe("why");
    expect(((completion.choices as Array<Record<string, unknown>>)[0].finish_reason)).toBe("tool_calls");
    expect((completion.usage as Record<string, number>).prompt_tokens).toBe(3);
  });

  it("converts chat completion to responses json", () => {
    const response = chatCompletionToResponsesJson(
      {
        choices: [{ message: { content: "hi", tool_calls: [{ id: "call_1", function: { name: "do", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 4, completion_tokens: 1 },
      },
      "gpt-4o"
    );
    expect(response.object).toBe("response");
    const output = response.output as Array<Record<string, unknown>>;
    expect(output[0].type).toBe("message");
    expect(output[1].type).toBe("function_call");
  });

  it("rebuilds a chat completion from an sse stream", async () => {
    const completion = await chatSseToChatCompletion(
      streamOf(
        'data: {"choices":[{"delta":{"content":"a"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"b"}}],"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n' +
          "data: [DONE]\n\n"
      ),
      "gpt-4o"
    );
    const message = (completion.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>;
    expect(message.content).toBe("ab");
    expect((completion.usage as Record<string, number>).completion_tokens).toBe(2);
  });

  it("clamps prompt cache keys", () => {
    expect(clampPromptCacheKey("abc")).toBe("abc");
    expect(clampPromptCacheKey("x".repeat(100)).length).toBe(64);
  });

  it("maps responses usage from chat usage", () => {
    const usage = responsesUsageFromChat({ prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } });
    expect(usage.input_tokens).toBe(10);
    expect((usage.input_tokens_details as Record<string, number>).cached_tokens).toBe(2);
    expect(usage.total_tokens).toBe(15);
  });
});

describe("anthropic transform", () => {
  it("builds a messages payload", async () => {
    const payload = await buildAnthropicMessagesPayload(
      {
        model: "claude",
        max_tokens: 100,
        temperature: 0.5,
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
        ],
        tools: [{ type: "function", function: { name: "x", description: "d", parameters: { type: "object" } } }],
      },
      "claude-sonnet",
      true
    );
    expect(payload.model).toBe("claude-sonnet");
    expect(payload.max_tokens).toBe(100);
    expect(payload.system).toBe("sys");
    expect((payload.tools as Array<Record<string, unknown>>)[0].name).toBe("x");
  });

  it("converts messages response to chat completion", () => {
    const completion = anthropicMessagesToChatCompletion(
      {
        id: "msg_1",
        stop_reason: "tool_use",
        content: [
          { type: "thinking", thinking: "why" },
          { type: "text", text: "hi" },
          { type: "tool_use", id: "toolu_1", name: "do", input: { a: 1 } },
        ],
        usage: { input_tokens: 3, output_tokens: 2 },
      },
      "claude"
    );
    const message = (completion.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>;
    expect(message.content).toBe("hi");
    expect(message.reasoning_content).toBe("why");
    expect(((completion.choices as Array<Record<string, unknown>>)[0].finish_reason)).toBe("tool_calls");
    const toolCalls = message.tool_calls as Array<Record<string, unknown>>;
    expect((toolCalls[0].function as Record<string, string>).arguments).toBe('{"a":1}');
  });
});
