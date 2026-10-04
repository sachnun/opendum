import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chatCompletionToResponsesJson,
  chatSseToChatCompletion,
  convertToolsForResponses,
  messagesToResponsesInput,
  normalizeResponsesInput,
  responsesJsonToChatCompletion,
  clampPromptCacheKey,
  responsesUsageFromChat,
} from "./responses-transform.js";
import { normalizeToolChoice } from "./helpers.js";
import { anthropicMessagesToChatCompletion, buildAnthropicMessagesPayload } from "./anthropic-transform.js";

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
    assert.equal(input[0].role, "developer");
    assert.equal(input[1].role, "user");
    assert.equal(input[2].type, "function_call");
    assert.equal(input[2].call_id, "fc_1");
    assert.equal(input[3].type, "function_call_output");
  });

  it("normalizes shorthand responses input", () => {
    const input = normalizeResponsesInput([
      { role: "user", content: [{ type: "input_text", text: "hey" }] },
      { call_id: "fc_1", name: "do", arguments: "{}" },
    ]) as Array<Record<string, unknown>>;
    assert.equal(input[0].type, "message");
    assert.equal(input[1].type, "function_call");
  });

  it("converts chat tools to responses tools", () => {
    const tools = convertToolsForResponses([
      { type: "function", function: { name: "x", description: "d", parameters: { type: "object" } } },
    ]) as Array<Record<string, unknown>>;
    assert.equal(tools[0].type, "function");
    assert.equal(tools[0].name, "x");
  });

  it("normalizes function tool choice", () => {
    assert.deepEqual(normalizeToolChoice({ type: "function", function: { name: "x" } }), { type: "function", name: "x" });
    assert.equal(normalizeToolChoice("auto"), "auto");
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
    assert.equal(message.content, "hello");
    assert.equal(message.reasoning_content, "why");
    assert.equal(((completion.choices as Array<Record<string, unknown>>)[0].finish_reason), "tool_calls");
    assert.equal((completion.usage as Record<string, number>).prompt_tokens, 3);
  });

  it("converts chat completion to responses json", () => {
    const response = chatCompletionToResponsesJson(
      {
        choices: [{ message: { content: "hi", tool_calls: [{ id: "call_1", function: { name: "do", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 4, completion_tokens: 1 },
      },
      "gpt-4o"
    );
    assert.equal(response.object, "response");
    const output = response.output as Array<Record<string, unknown>>;
    assert.equal(output[0].type, "message");
    assert.equal(output[1].type, "function_call");
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
    assert.equal(message.content, "ab");
    assert.equal((completion.usage as Record<string, number>).completion_tokens, 2);
  });

  it("clamps prompt cache keys", () => {
    assert.equal(clampPromptCacheKey("abc"), "abc");
    assert.equal(clampPromptCacheKey("x".repeat(100)).length, 64);
  });

  it("maps responses usage from chat usage", () => {
    const usage = responsesUsageFromChat({ prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } });
    assert.equal(usage.input_tokens, 10);
    assert.equal((usage.input_tokens_details as Record<string, number>).cached_tokens, 2);
    assert.equal(usage.total_tokens, 15);
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
    assert.equal(payload.model, "claude-sonnet");
    assert.equal(payload.max_tokens, 100);
    assert.equal(payload.system, "sys");
    assert.equal((payload.tools as Array<Record<string, unknown>>)[0].name, "x");
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
    assert.equal(message.content, "hi");
    assert.equal(message.reasoning_content, "why");
    assert.equal(((completion.choices as Array<Record<string, unknown>>)[0].finish_reason), "tool_calls");
    const toolCalls = message.tool_calls as Array<Record<string, unknown>>;
    assert.equal((toolCalls[0].function as Record<string, string>).arguments, '{"a":1}');
  });
});
