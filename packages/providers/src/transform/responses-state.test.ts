import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chatSseToResponsesStream } from "#providers/transform/responses-state.ts";

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
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  const events: Json[] = [];
  for (const block of text.split("\n\n")) {
    const line = block.trim();
    if (!line.startsWith("data: ")) continue;
    events.push(JSON.parse(line.slice("data: ".length)) as Json);
  }
  return events;
}

function data(payload: Json): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

describe("chatSseToResponsesStream", () => {
  it("emits a message response with text deltas and usage", async () => {
    const events = await collect(
      chatSseToResponsesStream(
        sseSource([
          data({ choices: [{ delta: { content: "he" } }] }),
          data({ choices: [{ delta: { content: "llo" }, finish_reason: "stop" }] }),
          data({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
          "data: [DONE]\n\n",
        ]),
        "gpt-4o"
      )
    );

    const types = events.map((event) => event.type);
    assert.equal(types[0], "response.created");
    assert.ok(types.includes("response.output_item.added"));
    assert.deepEqual(
      events.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta),
      ["he", "llo"]
    );

    const doneItem = events.find((event) => event.type === "response.output_item.done")?.item as Json;
    assert.equal((doneItem.content as Json[])[0]!.text, "hello");

    const completed = events.at(-1)!;
    assert.equal(completed.type, "response.completed");
    const response = completed.response as Json;
    assert.equal(response.status, "completed");
    assert.equal(((response.output as Json[])[0]!.content as Json[])[0]!.text, "hello");
    assert.equal((response.usage as Json).total_tokens, 4);
  });

  it("marks a length finish as incomplete", async () => {
    const events = await collect(
      chatSseToResponsesStream(
        sseSource([
          data({ choices: [{ delta: { content: "x" }, finish_reason: "length" }] }),
          "data: [DONE]\n\n",
        ]),
        "gpt-4o"
      )
    );
    const last = events.at(-1)!;
    assert.equal(last.type, "response.incomplete");
    const response = last.response as Json;
    assert.equal(response.status, "incomplete");
    assert.deepEqual(response.incomplete_details, { reason: "max_output_tokens" });
  });

  it("emits reasoning deltas as a reasoning item", async () => {
    const events = await collect(
      chatSseToResponsesStream(
        sseSource([data({ choices: [{ delta: { reasoning_content: "why" } }] }), "data: [DONE]\n\n"]),
        "gpt-4o"
      )
    );
    const delta = events.find((event) => event.type === "response.reasoning_text.delta");
    assert.equal(delta?.delta, "why");
    const doneItem = events.find((event) => event.type === "response.output_item.done")?.item as Json;
    assert.equal(doneItem.type, "reasoning");
    assert.equal((doneItem.summary as Json[])[0]!.text, "why");
  });

  it("accumulates tool call arguments", async () => {
    const events = await collect(
      chatSseToResponsesStream(
        sseSource([
          data({
            choices: [
              { delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: '{"q":' } }] } },
            ],
          }),
          data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }, finish_reason: "tool_calls" }] }),
          "data: [DONE]\n\n",
        ]),
        "gpt-4o"
      )
    );

    const added = events.find(
      (event) => event.type === "response.output_item.added" && (event.item as Json).type === "function_call"
    )?.item as Json;
    assert.equal(added.call_id, "fc_1");

    const output = (events.at(-1)!.response as Json).output as Json[];
    assert.equal(output[0]!.type, "function_call");
    assert.equal(output[0]!.arguments, '{"q":"x"}');
    assert.equal(output[0]!.name, "lookup");
  });

  it("skips malformed data lines", async () => {
    const events = await collect(
      chatSseToResponsesStream(sseSource(["data: {bad\n\n", "data: [DONE]\n\n"]), "gpt-4o")
    );
    assert.equal(events.at(-1)!.type, "response.completed");
  });

  it("closes open text before a tool call and assigns generated ids", async () => {
    const events = await collect(
      chatSseToResponsesStream(
        sseSource([
          data({ choices: [{ delta: { content: "thinking" } }] }),
          data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "lookup", arguments: "{}" } }] } }] }),
          "data: [DONE]\n\n",
        ]),
        "gpt-4o"
      )
    );
    const added = events.find(
      (event) => event.type === "response.output_item.added" && (event.item as Json).type === "function_call"
    )?.item as Json;
    assert.match(String(added.id), /^fc/);
    assert.equal(events.some((event) => event.type === "response.output_item.done"), true);
  });

  it("emits reasoning and tool items when finishing an open tool call", async () => {
    const events = await collect(
      chatSseToResponsesStream(
        sseSource([
          data({ choices: [{ delta: { reasoning_content: "why" } }] }),
          data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "f", arguments: "{}" } }] }, finish_reason: "stop" }] }),
          "data: [DONE]\n\n",
        ]),
        "gpt-4o"
      )
    );
    const output = (events.at(-1)!.response as Json).output as Json[];
    assert.equal(output.some((item) => item.type === "reasoning"), true);
    assert.equal(output.some((item) => item.type === "function_call"), true);
  });
});
