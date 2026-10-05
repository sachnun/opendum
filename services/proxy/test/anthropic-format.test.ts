import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  transformAnthropicToOpenAI,
  transformOpenAIToAnthropic,
} from "../src/core/streaming/anthropic-format.ts";

type Json = Record<string, unknown>;

describe("transformAnthropicToOpenAI", () => {
  it("converts tools, images, tool calls and results", () => {
    const payload = transformAnthropicToOpenAI({
      model: "claude",
      system: [{ type: "text", text: "sys" }],
      max_tokens: 10,
      tools: [{ name: "f", description: "d", input_schema: { type: "object" } }, { function: { name: "g" } }],
      tool_choice: { type: "tool", name: "f" },
      thinking: { type: "enabled", budget_tokens: 2000 },
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }, { type: "image", source: { url: "https://x/y.png" } }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: { a: 1 } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }, { type: "text", text: "q" }] },
      ],
    });
    assert.equal(payload.max_tokens, 10);
    assert.equal(payload.thinking_budget, 2000);
    assert.equal(payload._includeReasoning, true);
    assert.equal("system" in payload, false);
    assert.deepEqual(payload.tools, [
      { type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } },
      { function: { name: "g" } },
    ]);
    assert.deepEqual(payload.tool_choice, { type: "function", function: { name: "f" } });
    const messages = payload.messages as Json[];
    assert.equal(messages.length, 5);
    assert.equal(messages[0]!.role, "system");
    assert.deepEqual(messages[1]!.content, [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "https://x/y.png" } }]);
    assert.deepEqual((messages[2]!.tool_calls as Json[])[0]!.function, { name: "f", arguments: '{"a":1}' });
    assert.equal(messages[3]!.role, "tool");
    assert.equal(messages[4]!.content, "q");
  });

  it("defaults max tokens and handles adaptive thinking", () => {
    const payload = transformAnthropicToOpenAI({ bodyField: "x", thinking: { type: "adaptive" }, output_config: { effort: "low" } });
    assert.equal(payload.max_tokens, 4096);
    assert.equal(payload.reasoning_effort, "low");
    assert.equal(payload._includeReasoning, true);
    assert.equal(payload.bodyField, "x");
  });

  it("drops orphaned tool uses and handles plain content", () => {
    const payload = transformAnthropicToOpenAI({
      messages: [
        { role: "user", content: "plain" },
        { role: "assistant", content: [{ type: "tool_use", id: "orphan", name: "f", input: {} }] },
        { role: "user", content: 42 },
      ],
    });
    const messages = payload.messages as Json[];
    assert.deepEqual(messages, [{ role: "user", content: "plain" }]);
  });

  it("keeps pass-through tool choices", () => {
    assert.equal(transformAnthropicToOpenAI({ tool_choice: "auto" }).tool_choice, "auto");
    assert.equal(transformAnthropicToOpenAI({ tool_choice: "none" }).tool_choice, "none");
    assert.equal(transformAnthropicToOpenAI({ tool_choice: "custom" }).tool_choice, "custom");
    assert.deepEqual(transformAnthropicToOpenAI({ tool_choice: { type: "any" } }).tool_choice, "required");
    assert.deepEqual(transformAnthropicToOpenAI({ tool_choice: { function: { name: "g" } } }).tool_choice, { function: { name: "g" } });
  });
});

describe("transformOpenAIToAnthropic", () => {
  it("converts messages, tool calls and usage", () => {
    const result = transformOpenAIToAnthropic(
      {
        id: "abc",
        choices: [
          {
            message: {
              content: "hi",
              reasoning_content: "why",
              tool_calls: [
                { id: "t1", function: { name: "f", arguments: '{"a":1}' } },
                { id: "t2", function: { name: "g", arguments: "bad" } },
              ],
            },
            finish_reason: "length",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 1 } },
      },
      "claude"
    );
    assert.equal(result.id, "msg_abc");
    assert.equal(result.stop_reason, "max_tokens");
    const content = result.content as Json[];
    assert.deepEqual(content[0], { type: "thinking", thinking: "why" });
    assert.deepEqual(content[1], { type: "text", text: "hi" });
    assert.deepEqual(content[2], { type: "tool_use", id: "t1", name: "f", input: { a: 1 } });
    assert.deepEqual(content[3], { type: "tool_use", id: "t2", name: "g", input: {} });
    assert.deepEqual(result.usage, { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 1 });
  });

  it("handles empty completions", () => {
    const result = transformOpenAIToAnthropic({}, "claude");
    assert.deepEqual(result.content, [{ type: "text", text: "" }]);
    assert.equal(result.stop_reason, "end_turn");
    assert.equal(result.stop_sequence, null);
  });

  it("keeps tool_use stop reasons without length override", () => {
    const result = transformOpenAIToAnthropic(
      { choices: [{ message: { tool_calls: [{ id: "t1", function: { name: "f", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
      "claude"
    );
    assert.equal(result.stop_reason, "tool_use");
  });
});

describe("anthropic-format edge branches", () => {
  it("skips unnamed tools and handles tool choice variants", () => {
    assert.deepEqual(transformAnthropicToOpenAI({ tools: [{ type: "custom" }] }).tools, []);
    assert.equal(transformAnthropicToOpenAI({ tool_choice: null }).tool_choice, null);
    assert.equal(transformAnthropicToOpenAI({ tool_choice: { type: "auto" } }).tool_choice, "auto");
    assert.equal(transformAnthropicToOpenAI({ tool_choice: { type: "none" } }).tool_choice, "none");
    assert.deepEqual(transformAnthropicToOpenAI({ tool_choice: { type: "tool", function: { name: "g" } } }).tool_choice, { type: "tool", function: { name: "g" } });
    assert.deepEqual(transformAnthropicToOpenAI({ tool_choice: { type: "tool", name: "g" } }).tool_choice, { type: "function", function: { name: "g" } });
    assert.deepEqual(transformAnthropicToOpenAI({ tool_choice: { type: "unknown" } }).tool_choice, { type: "unknown" });
  });

  it("ignores disabled thinking and defaults adaptive effort", () => {
    const disabled = transformAnthropicToOpenAI({ thinking: { type: "disabled" } });
    assert.equal("thinking_budget" in disabled, false);
    const adaptive = transformAnthropicToOpenAI({ thinking: { type: "adaptive" } });
    assert.equal(adaptive.reasoning_effort, "high");
  });

  it("ignores unknown content blocks and coerces system/tool text", () => {
    const payload = transformAnthropicToOpenAI({
      system: 5,
      messages: [{ role: "user", content: [{ type: "unknown", value: 1 }, { type: "text", text: "hi" }] }],
    });
    const messages = payload.messages as Json[];
    assert.equal(messages[0]!.content, "");
    assert.equal(messages[1]!.content, "hi");
  });

  it("stringifies non-string tool results and maps cache writes", () => {
    const payload = transformAnthropicToOpenAI({
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: { ok: true } }] }],
    });
    const toolMessage = (payload.messages as Json[]).find((message) => message.role === "tool")!;
    assert.equal(toolMessage.content, JSON.stringify({ ok: true }));

    const result = transformOpenAIToAnthropic({ usage: { prompt_tokens: 1, completion_tokens: 1, cache_creation_input_tokens: 3 } }, "claude");
    assert.equal((result.usage as Json).cache_creation_input_tokens, 3);
  });
});
