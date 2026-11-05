import { describe, expect, it } from "bun:test";
import { emptyUsage, type IrEvent } from "@opendum/protocol/ir";
import { encodeEvents, upstreamEvents } from "@opendum/protocol/stream";
import { streamDecoder, streamEncoder } from "@opendum/protocol/upstream";

const encoder = new TextEncoder();

function streamOf(chunks: ReadonlyArray<string>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function event(data: string, name = ""): string {
  return name ? `event: ${name}\ndata: ${data}\n\n` : `data: ${data}\n\n`;
}

async function collectWith(events: ReadonlyArray<IrEvent>, dialect: "chat" | "responses" | "messages"): Promise<string> {
  async function* generate(): AsyncGenerator<IrEvent> {
    for (const item of events) yield item;
  }
  return new Response(encodeEvents(generate(), streamEncoder(dialect))).text();
}

async function collect(events: ReadonlyArray<IrEvent>): Promise<string> {
  return collectWith(events, "chat");
}

async function decodeAll(
  source: ReadableStream<Uint8Array>,
  dialect: "chat" | "responses" | "messages"
): Promise<IrEvent[]> {
  const out: IrEvent[] = [];
  for await (const event of upstreamEvents(source, streamDecoder(dialect, "m"))) out.push(event);
  return out;
}

const usage = { ...emptyUsage(), inputTokens: 3, outputTokens: 2 };

describe("upstream event decoding", () => {
  it("decodes a chat completion stream", async () => {
    const events = await decodeAll(
      streamOf([
        event(JSON.stringify({ id: "c1", model: "gpt", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "why" } }] })),
        event(JSON.stringify({ id: "c1", model: "gpt", choices: [{ index: 0, delta: { content: "hi" } }] })),
        event(JSON.stringify({ id: "c1", model: "gpt", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "do", arguments: "{\"a\"" } }] } }] })),
        event(JSON.stringify({ id: "c1", model: "gpt", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 3, completion_tokens: 2 } })),
        event("[DONE]"),
      ]),
      "chat"
    );
    expect(events.map((item) => item.type)).toEqual([
      "start",
      "reasoning_delta",
      "text_delta",
      "tool_start",
      "tool_args_delta",
      "tool_args_delta",
      "finish",
    ]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_calls", usage });
  });

  it("decodes an anthropic messages stream", async () => {
    const events = await decodeAll(
      streamOf([
        event(JSON.stringify({ type: "message_start", message: { id: "msg_1", model: "claude", usage: { input_tokens: 3 } } }), "message_start"),
        event(JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }), "content_block_start"),
        event(JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "why" } }), "content_block_delta"),
        event(JSON.stringify({ type: "content_block_stop", index: 0 }), "content_block_stop"),
        event(JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }), "content_block_start"),
        event(JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hi" } }), "content_block_delta"),
        event(JSON.stringify({ type: "content_block_stop", index: 1 }), "content_block_stop"),
        event(JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }), "message_delta"),
        event(JSON.stringify({ type: "message_stop" }), "message_stop"),
      ]),
      "messages"
    );
    expect(events.map((item) => item.type)).toEqual([
      "start",
      "reasoning_delta",
      "text_delta",
      "finish",
    ]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop", usage });
  });

  it("decodes a responses stream", async () => {
    const events = await decodeAll(
      streamOf([
        event(JSON.stringify({ type: "response.created", response: { id: "resp_1", model: "gpt" } })),
        event(JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { id: "rs_1", type: "reasoning" } })),
        event(JSON.stringify({ type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, summary_index: 0, delta: "why" })),
        event(JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "why" }] } })),
        event(JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", output_index: 1, content_index: 0, delta: "hi" })),
        event(JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 3, output_tokens: 2 } } })),
      ]),
      "responses"
    );
    expect(events.map((item) => item.type)).toEqual(["start", "reasoning_delta", "text_delta", "finish"]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop", usage });
  });
});

describe("downstream event encoding", () => {
  const events: IrEvent[] = [
    { type: "start", id: "x1", model: "m" },
    { type: "reasoning_delta", text: "why" },
    { type: "text_delta", text: "hi" },
    { type: "tool_start", index: 0, id: "call_1", name: "do" },
    { type: "tool_args_delta", index: 0, json: "{}" },
    { type: "finish", reason: "tool_calls", usage },
  ];

  it("writes chat completion chunks", async () => {
    const text = await collect(events);
    expect(text).toMatch(/"object":"chat.completion.chunk"/);
    expect(text).toMatch(/"reasoning_content":"why"/);
    expect(text).toMatch(/"finish_reason":"tool_calls"/);
    expect(text).toMatch(/"usage":\{"prompt_tokens":3/);
    expect(text).toMatch(/data: \[DONE\]/);
  });

  it("writes anthropic messages events", async () => {
    const text = await collectWith(events, "messages");
    expect(text).toMatch(/event: message_start/);
    expect(text).toMatch(/"type":"thinking_delta"/);
    expect(text).toMatch(/"type":"text_delta"/);
    expect(text).toMatch(/"type":"tool_use"/);
    expect(text).toMatch(/"stop_reason":"tool_use"/);
    expect(text).toMatch(/event: message_stop/);
  });

  it("writes responses events", async () => {
    const text = await collectWith(events, "responses");
    expect(text).toMatch(/"type":"response.created"/);
    expect(text).toMatch(/"type":"response.reasoning_summary_text.delta"/);
    expect(text).toMatch(/"type":"response.output_text.delta"/);
    expect(text).toMatch(/"type":"response.function_call_arguments.delta"/);
    expect(text).toMatch(/"type":"response.completed"/);
  });
});

describe("cross dialect streaming", () => {
  it("converts an anthropic stream into a chat completion stream", async () => {
    const source = streamOf([
      event(JSON.stringify({ type: "message_start", message: { id: "msg_1", model: "claude", usage: { input_tokens: 3 } } }), "message_start"),
      event(JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }), "content_block_start"),
      event(JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }), "content_block_delta"),
      event(JSON.stringify({ type: "content_block_stop", index: 0 }), "content_block_stop"),
      event(JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }), "message_delta"),
      event(JSON.stringify({ type: "message_stop" }), "message_stop"),
    ]);
    async function* relay(): AsyncGenerator<IrEvent> {
      for await (const decoded of upstreamEvents(source, streamDecoder("messages", "claude"))) yield decoded;
    }
    const text = await new Response(encodeEvents(relay(), streamEncoder("chat"))).text();
    expect(text).toMatch(/"content":"hi"/);
    expect(text).toMatch(/"finish_reason":"stop"/);
    expect(text).toMatch(/data: \[DONE\]/);
  });
});
