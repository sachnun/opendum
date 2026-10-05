import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  anthropicMessagesToChatCompletion,
  buildAnthropicMessagesPayload,
} from "#providers/transform/anthropic.ts";

type Json = Record<string, unknown>;

describe("buildAnthropicMessagesPayload", () => {
  it("converts chat messages and options", async () => {
    const payload = await buildAnthropicMessagesPayload(
      {
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello", tool_calls: [{ id: "t1", function: { name: "f", arguments: '{"a":1}' } }] },
          { role: "tool", tool_call_id: "t1", content: "result" },
        ],
        max_tokens: 100,
        temperature: 0.5,
        top_p: 0.9,
        stop: ["STOP"],
        tools: [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } }],
        tool_choice: "auto",
      },
      "claude-x",
      false
    );

    assert.equal(payload.model, "claude-x");
    assert.equal(payload.stream, false);
    assert.equal(payload.max_tokens, 100);
    assert.equal(payload.system, "sys");
    assert.equal(payload.temperature, 0.5);
    assert.equal(payload.top_p, 0.9);
    assert.deepEqual(payload.stop_sequences, ["STOP"]);
    assert.deepEqual(payload.tools, [{ name: "f", description: "d", input_schema: { type: "object" } }]);
    assert.deepEqual(payload.tool_choice, { type: "auto" });
    assert.equal((payload.messages as unknown[]).length, 3);
  });

  it("defaults max tokens and omits empty values", async () => {
    const payload = await buildAnthropicMessagesPayload({ messages: [] }, "m", true);
    assert.equal(payload.max_tokens, 4096);
    assert.equal(payload.stream, true);
    assert.deepEqual(payload.messages, []);
    assert.equal("system" in payload, false);
    assert.equal("stop_sequences" in payload, false);
  });

  it("maps stop strings and thinking budgets", async () => {
    const single = await buildAnthropicMessagesPayload({ messages: [], stop: "X" }, "m", false);
    assert.deepEqual(single.stop_sequences, ["X"]);

    const thinking = await buildAnthropicMessagesPayload({ messages: [], thinking_budget: 2000, max_tokens: 1000 }, "m", false);
    assert.deepEqual(thinking.thinking, { type: "enabled", budget_tokens: 2000 });
    assert.equal(thinking.max_tokens, 3024);
  });

  it("derives thinking budgets from effort", async () => {
    const payload = await buildAnthropicMessagesPayload(
      { messages: [], _includeReasoning: true, reasoning_effort: "high", max_tokens: 100 },
      "m",
      false
    );
    assert.deepEqual(payload.thinking, { type: "enabled", budget_tokens: 16384 });
    assert.equal(payload.max_tokens, 17408);
  });

  it("converts tool definitions and choices", async () => {
    const payload = await buildAnthropicMessagesPayload(
      { messages: [], tools: [{ name: "g", parameters: {} }], tool_choice: { type: "function", function: { name: "g" } } },
      "m",
      false
    );
    assert.deepEqual(payload.tools, [{ name: "g", input_schema: {} }]);
    assert.deepEqual(payload.tool_choice, { type: "tool", name: "g" });
  });

  it("converts image blocks", async () => {
    const payload = await buildAnthropicMessagesPayload(
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
              { type: "image_url", image_url: { url: "https://x/y.png" } },
              { type: "image", source: { type: "base64", data: "ZZ" } },
              { type: "text", text: "t" },
            ],
          },
        ],
      },
      "m",
      false
    );
    const blocks = ((payload.messages as Json[])[0]!.content as Json[]);
    assert.deepEqual(blocks[0], { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
    assert.deepEqual(blocks[1], { type: "image", source: { type: "url", url: "https://x/y.png" } });
    assert.deepEqual(blocks[2], { type: "image", source: { type: "base64", data: "ZZ" } });
    assert.deepEqual(blocks[3], { type: "text", text: "t" });
  });
});

describe("anthropicMessagesToChatCompletion", () => {
  it("converts text, thinking and tool calls", () => {
    const completion = anthropicMessagesToChatCompletion(
      {
        id: "msg_1",
        content: [
          { type: "text", text: "hi" },
          { type: "thinking", thinking: "hmm" },
          { type: "tool_use", id: "t1", name: "f", input: { a: 1 } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 2 },
      },
      "claude-x"
    );
    const choice = (completion.choices as Json[])[0]!;
    const message = choice.message as Json;
    assert.equal(message.content, "hi");
    assert.equal(message.reasoning_content, "hmm");
    assert.deepEqual(message.tool_calls, [{ id: "t1", type: "function", function: { name: "f", arguments: '{"a":1}' } }]);
    assert.equal(choice.finish_reason, "tool_calls");
    assert.equal(completion.id, "msg_1");
    assert.equal(completion.model, "claude-x");
    assert.equal((completion.usage as Json).total_tokens, 3);
  });

  it("handles missing fields and stop reasons", () => {
    const maxed = anthropicMessagesToChatCompletion({ content: [{ type: "text", text: "x" }], stop_reason: "max_tokens" }, "m");
    assert.equal((maxed.choices as Json[])[0]!.finish_reason, "length");

    const plain = anthropicMessagesToChatCompletion({ content: [{ type: "tool_use", name: "f" }], stop_reason: "end_turn" }, "m");
    const message = (plain.choices as Json[])[0]!.message as Json;
    assert.equal(message.content, null);
    assert.equal(((message.tool_calls as Json[])[0]!.function as Json).arguments, "{}");
    assert.equal((plain.choices as Json[])[0]!.finish_reason, "tool_calls");
  });
});
