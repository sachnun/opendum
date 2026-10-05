import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  responseUsageToChatUsage,
  responsesJsonToChatCompletion,
  responsesSseToChatStream,
} from "#providers/transform/responses-stream.ts";

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

async function collect(stream: ReadableStream<Uint8Array>): Promise<Json[]> {
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
  return events;
}

function data(payload: Json): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function choice(event: Json): Json {
  return (event.choices as Json[])[0]!;
}

describe("responseUsageToChatUsage", () => {
  it("maps input and output tokens", () => {
    assert.deepEqual(responseUsageToChatUsage({ input_tokens: 10, output_tokens: 2 }), {
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
    });
    assert.deepEqual(responseUsageToChatUsage({ prompt_tokens: 5, completion_tokens: 1 }), {
      prompt_tokens: 5,
      completion_tokens: 1,
      total_tokens: 6,
    });
  });

  it("maps cache and reasoning details", () => {
    assert.deepEqual(
      responseUsageToChatUsage({
        input_tokens: 4,
        output_tokens: 1,
        input_tokens_details: { cached_tokens: 3, cache_write_tokens: 1 },
        output_tokens_details: { reasoning_tokens: 2 },
      }),
      {
        prompt_tokens: 4,
        completion_tokens: 1,
        total_tokens: 5,
        prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 1 },
        completion_tokens_details: { reasoning_tokens: 2 },
      }
    );
  });

  it("falls back to prompt and completion detail shapes", () => {
    assert.deepEqual(
      responseUsageToChatUsage({
        input_tokens: 4,
        output_tokens: 1,
        prompt_tokens_details: { cached_tokens: 3 },
        completion_tokens_details: { reasoning_tokens: 2 },
      }),
      {
        prompt_tokens: 4,
        completion_tokens: 1,
        total_tokens: 5,
        prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 2 },
      }
    );
  });
});

describe("responsesJsonToChatCompletion", () => {
  it("collects output text, reasoning and tool calls", () => {
    const completion = responsesJsonToChatCompletion(
      {
        status: "completed",
        output: [
          { type: "message", content: [{ type: "output_text", text: "hi" }] },
          { type: "reasoning", summary: [{ text: "why" }] },
          { type: "function_call", call_id: "c1", name: "f", arguments: '{"a":1}' },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      "m"
    );
    const message = (completion.choices as Json[])[0]!.message as Json;
    assert.equal(message.content, "hi");
    assert.equal(message.reasoning_content, "why");
    assert.deepEqual(message.tool_calls, [{ id: "call_c1", type: "function", function: { name: "f", arguments: '{"a":1}' } }]);
    assert.equal((completion.choices as Json[])[0]!.finish_reason, "tool_calls");
  });

  it("handles reasoning content arrays and fallback text", () => {
    const completion = responsesJsonToChatCompletion(
      {
        output: [
          { type: "reasoning", content: [{ text: "c" }] },
          { type: "reasoning", text: "plain" },
        ],
      },
      "m"
    );
    assert.equal(((completion.choices as Json[])[0]!.message as Json).reasoning_content, "cplain");
  });

  it("handles an empty output and incomplete status", () => {
    const empty = responsesJsonToChatCompletion({ output: [], status: "incomplete" }, "m");
    assert.equal(((empty.choices as Json[])[0]!.message as Json).content, null);
    assert.equal((empty.choices as Json[])[0]!.finish_reason, "length");
  });
});

describe("responsesSseToChatStream", () => {
  it("streams text deltas", async () => {
    const events = await collect(
      responsesSseToChatStream(
        sseSource([
          data({ type: "response.output_text.delta", delta: "hi" }),
          data({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } }),
          "data: [DONE]\n\n",
        ]),
        "m"
      )
    );
    assert.equal((choice(events[0]!).delta as Json).role, "assistant");
    assert.equal(events.some((event) => (choice(event).delta as Json).content === "hi"), true);
    assert.equal(choice(events.at(-1)!).finish_reason, "stop");
  });

  it("streams tool calls", async () => {
    const events = await collect(
      responsesSseToChatStream(
        sseSource([
          data({ type: "response.output_item.added", item: { type: "function_call", call_id: "c1", name: "f" } }),
          data({ type: "response.function_call_arguments.delta", delta: '{"a":' }),
          data({ type: "response.function_call_arguments.done" }),
          data({ type: "response.completed", response: { status: "completed" } }),
          "data: [DONE]\n\n",
        ]),
        "m"
      )
    );
    const callEvent = events.find((event) => Array.isArray((choice(event).delta as Json).tool_calls));
    const call = ((choice(callEvent!).delta as Json).tool_calls as Json[])[0]!;
    assert.equal(call.id, "call_c1");
    assert.equal((call.function as Json).name, "f");
    assert.equal(choice(events.at(-1)!).finish_reason, "tool_calls");
  });

  it("streams reasoning deltas and summary items", async () => {
    const events = await collect(
      responsesSseToChatStream(
        sseSource([
          data({ type: "response.reasoning_summary_text.delta", summary_index: 0, delta: "why" }),
          data({ type: "response.output_item.done", item: { type: "reasoning", summary: [{ text: "more" }] } }),
          "data: [DONE]\n\n",
        ]),
        "m"
      )
    );
    const reasoning = events
      .map((event) => (choice(event).delta as Json).reasoning_content)
      .filter((value): value is string => typeof value === "string")
      .join("");
    assert.equal(reasoning, "whymore");
  });

  it("marks incomplete responses as length", async () => {
    const events = await collect(
      responsesSseToChatStream(
        sseSource([data({ type: "response.completed", response: { status: "incomplete" } }), "data: [DONE]\n\n"]),
        "m"
      )
    );
    assert.equal(choice(events.at(-1)!).finish_reason, "length");
  });

  it("collects reasoning from string summaries and content", async () => {
    const events = await collect(
      responsesSseToChatStream(
        sseSource([
          data({ type: "response.output_item.done", item: { type: "reasoning", summary: ["plain", { text: "obj" }] } }),
          data({ type: "response.output_item.done", item: { type: "reasoning", content: [{ text: "content" }] } }),
          data({ type: "response.output_item.done", item: { type: "reasoning", text: "fallback" } }),
          "data: [DONE]\n\n",
        ]),
        "m"
      )
    );
    const reasoning = events
      .map((event) => (choice(event).delta as Json).reasoning_content)
      .filter((value): value is string => typeof value === "string")
      .join("");
    assert.equal(reasoning, "plain\n\nobj\n\ncontentfallback");
  });

  it("handles reasoning summary part done and malformed lines", async () => {
    const events = await collect(
      responsesSseToChatStream(
        sseSource([
          "data: not json\n\n",
          data({ type: "response.reasoning_summary_part.done", summary_index: 0, part: { text: "part" } }),
          data({ type: "response.reasoning_text.done", content_index: 0, text: "text-done" }),
          data({ type: "response.reasoning_summary_text.done", summary_index: 1, text: "summary-done" }),
          "data: [DONE]\n\n",
        ]),
        "m"
      )
    );
    const reasoning = events
      .map((event) => (choice(event).delta as Json).reasoning_content)
      .filter((value): value is string => typeof value === "string")
      .join("");
    assert.equal(reasoning, "part\n\ntext-done\n\nsummary-done");
  });
});
