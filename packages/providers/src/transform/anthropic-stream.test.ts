import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  anthropicMessagesSseToChatStream,
  anthropicStopReasonToFinish,
  anthropicUsageToChatUsage,
} from "#providers/transform/anthropic-stream.ts";

type Json = Record<string, unknown>;

function sseSource(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<{ raw: string; events: Json[] }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
  }
  raw += decoder.decode();
  const events: Json[] = [];
  for (const block of raw.split("\n\n")) {
    const line = block.trim();
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice("data: ".length);
    if (payload === "[DONE]") continue;
    events.push(JSON.parse(payload) as Json);
  }
  return { raw, events };
}

function data(payload: Json): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function choiceOf(event: Json): Json {
  return (event.choices as Json[])[0]!;
}

describe("anthropicStopReasonToFinish", () => {
  it("maps stop reasons", () => {
    assert.equal(anthropicStopReasonToFinish("max_tokens", false), "length");
    assert.equal(anthropicStopReasonToFinish("tool_use", false), "tool_calls");
    assert.equal(anthropicStopReasonToFinish("refusal", false), "content_filter");
    assert.equal(anthropicStopReasonToFinish("end_turn", false), "stop");
    assert.equal(anthropicStopReasonToFinish("end_turn", true), "tool_calls");
  });
});

describe("anthropicUsageToChatUsage", () => {
  it("maps basic usage", () => {
    assert.deepEqual(anthropicUsageToChatUsage({ input_tokens: 10, output_tokens: 2 }), {
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
    });
  });

  it("adds cache details when present", () => {
    assert.deepEqual(
      anthropicUsageToChatUsage({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 }),
      {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
        prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 1 },
      }
    );
  });
});

describe("anthropicMessagesSseToChatStream", () => {
  it("converts text deltas and finish reasons", async () => {
    const { raw, events } = await collect(
      anthropicMessagesSseToChatStream(
        sseSource([
          data({ type: "message_start", message: { id: "msg_1", model: "claude-x" } }),
          data({ type: "content_block_delta", delta: { type: "text_delta", text: "hello" } }),
          data({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 2, output_tokens: 1 } }),
          data({ type: "message_stop" }),
          "data: [DONE]\n\n",
        ]),
        "fallback"
      )
    );

    assert.ok(raw.trimEnd().endsWith("data: [DONE]"));
    const roleEvent = events.find((event) => (choiceOf(event).delta as Json).role === "assistant");
    assert.ok(roleEvent, "expected an initial role chunk");
    assert.equal(roleEvent!.id, "msg_1");
    assert.equal(roleEvent!.model, "claude-x");

    const textEvent = events.find((event) => (choiceOf(event).delta as Json).content === "hello");
    assert.ok(textEvent);

    const finishEvent = events.at(-1)!;
    assert.equal(choiceOf(finishEvent).finish_reason, "stop");
    assert.equal((finishEvent.usage as Json).total_tokens, 3);
  });

  it("converts tool use blocks and argument deltas", async () => {
    const { events } = await collect(
      anthropicMessagesSseToChatStream(
        sseSource([
          data({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "lookup" } }),
          data({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"q":' } }),
          data({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"x"}' } }),
          data({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
          data({ type: "message_stop" }),
          "data: [DONE]\n\n",
        ]),
        "claude-x"
      )
    );

    const callEvent = events.find((event) => {
      const calls = (choiceOf(event).delta as Json).tool_calls as Json[] | undefined;
      return Array.isArray(calls) && calls[0]!.function !== undefined && (calls[0]!.function as Json).name === "lookup";
    });
    assert.ok(callEvent, "expected a tool call chunk");
    const call = ((choiceOf(callEvent!).delta as Json).tool_calls as Json[])[0]!;
    assert.equal(call.id, "toolu_1");
    assert.equal(call.index, 0);

    const args = events
      .flatMap((event) => ((choiceOf(event).delta as Json).tool_calls as Json[] | undefined) ?? [])
      .map((call) => ((call.function as Json).arguments as string) ?? "")
      .join("");
    assert.equal(args, '{"q":"x"}');

    assert.equal(choiceOf(events.at(-1)!).finish_reason, "tool_calls");
  });

  it("emits a terminal role chunk for an empty stream", async () => {
    const { events } = await collect(anthropicMessagesSseToChatStream(sseSource([]), "claude-x"));
    assert.equal(events.length, 1);
    assert.equal((choiceOf(events[0]!).delta as Json).role, "assistant");
    assert.equal(choiceOf(events[0]!).finish_reason, "stop");
  });

  it("starts tool_use blocks from content_block_start", async () => {
    const { events } = await collect(
      anthropicMessagesSseToChatStream(
        sseSource([
          data({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
          data({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "lookup" } }),
          data({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"a":1}' } }),
          data({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
          data({ type: "message_stop" }),
          "data: [DONE]\n\n",
        ]),
        "claude-x"
      )
    );
    const start = events.find((event) => {
      const calls = (choiceOf(event).delta as Json).tool_calls as Json[] | undefined;
      return Array.isArray(calls) && (calls[0]!.function as Json).name === "lookup";
    })!;
    const call = ((choiceOf(start).delta as Json).tool_calls as Json[])[0]!;
    assert.equal(call.id, "toolu_1");
    assert.equal(call.index, 0);
    const args = events
      .flatMap((event) => ((choiceOf(event).delta as Json).tool_calls as Json[] | undefined) ?? [])
      .map((entry) => ((entry.function as Json).arguments as string) ?? "")
      .join("");
    assert.equal(args, '{"a":1}');
  });

  it("starts implicit tool blocks from input deltas", async () => {
    const { events } = await collect(
      anthropicMessagesSseToChatStream(
        sseSource([
          data({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{}" } }),
          "data: [DONE]\n\n",
        ]),
        "claude-x"
      )
    );
    const call = events
      .flatMap((event) => ((choiceOf(event).delta as Json).tool_calls as Json[] | undefined) ?? [])[0]!;
    assert.match(call.id as string, /^call/);
    assert.equal((call.function as Json).name, "");
  });

  it("ignores empty input deltas", async () => {
    const { events } = await collect(
      anthropicMessagesSseToChatStream(
        sseSource([data({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "" } }), "data: [DONE]\n\n"]),
        "claude-x"
      )
    );
    assert.equal(events.length, 1);
  });
});
