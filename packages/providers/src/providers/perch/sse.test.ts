import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PerchUpstreamError,
  perchSseToChatCompletion,
  perchSseToChatStream,
} from "#providers/providers/perch/sse.ts";

type Json = Record<string, unknown>;

function response(lines: string[]): Response {
  return new Response(lines.join("\n"), { status: 200 });
}

function data(payload: Json): string {
  return `data: ${JSON.stringify(payload)}`;
}

describe("perchSseToChatCompletion", () => {
  it("aggregates reasoning, content and usage", async () => {
    const completion = await perchSseToChatCompletion(
      response([
        data({ type: "reasoning_delta", text: "why" }),
        data({ type: "answer_delta", text: "hello" }),
        data({ type: "done", ok: true, usage: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 3 } }),
      ]),
      "perch-model",
      true
    );

    const message = ((completion.choices as Json[])[0]!.message as Json);
    assert.equal(message.content, "hello");
    assert.equal(message.reasoning_content, "why");
    assert.equal((completion.choices as Json[])[0]!.finish_reason, "stop");
    assert.deepEqual(completion.usage, {
      prompt_tokens: 13,
      completion_tokens: 2,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 3 },
    });
  });

  it("omits reasoning when disabled", async () => {
    const completion = await perchSseToChatCompletion(
      response([data({ type: "reasoning_delta", text: "why" }), data({ type: "answer_delta", text: "hi" })]),
      "perch-model",
      false
    );
    const message = ((completion.choices as Json[])[0]!.message as Json);
    assert.equal("reasoning_content" in message, false);
  });

  it("collects tool calls and prefers sealed arguments", async () => {
    const completion = await perchSseToChatCompletion(
      response([
        data({ type: "tool_call_delta", toolCalls: [{ id: "t1", name: "lookup", rawArgumentsText: '{"q":' }] }),
        data({ type: "tool_call_delta", toolCalls: [{ id: "t1", rawArgumentsText: '"x"}' }] }),
        data({ type: "tool_use_end", toolCalls: [{ id: "t1", arguments: { final: true } }] }),
        data({ type: "done", ok: true }),
      ]),
      "perch-model",
      false
    );
    const message = ((completion.choices as Json[])[0]!.message as Json);
    assert.deepEqual(message.tool_calls, [
      { id: "t1", type: "function", function: { name: "lookup", arguments: '{"final":true}' } },
    ]);
    assert.equal((completion.choices as Json[])[0]!.finish_reason, "tool_calls");
  });

  it("throws a quota upstream error on failure", async () => {
    await assert.rejects(
      perchSseToChatCompletion(response([data({ type: "done", ok: false, error: "usage limit exceeded" })]), "m", false),
      (error: unknown) => {
        assert.ok(error instanceof PerchUpstreamError);
        assert.equal(error.quota, true);
        assert.match(error.message, /usage limit/);
        return true;
      }
    );
  });

  it("serializes a non-string error and defaults usage", async () => {
    await assert.rejects(
      perchSseToChatCompletion(response([data({ type: "done", ok: false, error: { code: 1 } })]), "m", false),
      (error: unknown) => {
        assert.ok(error instanceof PerchUpstreamError);
        assert.equal(error.quota, false);
        assert.equal(error.message, '{"code":1}');
        return true;
      }
    );

    const completion = await perchSseToChatCompletion(response([data({ type: "answer_delta", text: "hi" })]), "m", false);
    assert.deepEqual(completion.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });
});

describe("perchSseToChatStream", () => {
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

  function source(lines: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`${lines.join("\n")}\n`));
        controller.close();
      },
    });
  }

  function choice(event: Json): Json {
    return (event.choices as Json[])[0]!;
  }

  it("streams role, content and a terminal chunk", async () => {
    const events = await collect(
      perchSseToChatStream(source([data({ type: "answer_delta", text: "hello" }), data({ type: "done", ok: true })]), "m", false)
    );
    assert.equal(((choice(events[0]!).delta as Json).role), "assistant");
    assert.equal(((choice(events.find((event) => (choice(event).delta as Json).content === "hello")!).delta as Json).content), "hello");
    assert.equal(choice(events.at(-1)!).finish_reason, "stop");
  });

  it("terminates an unterminated stream", async () => {
    const events = await collect(perchSseToChatStream(source([data({ type: "answer_delta", text: "hi" })]), "m", false));
    assert.equal(choice(events.at(-1)!).finish_reason, "stop");
  });

  it("streams reasoning, tool calls and done events", async () => {
    const events = await collect(
      perchSseToChatStream(
        source([
          data({ type: "reasoning_delta", text: "why" }),
          data({ type: "tool_call_delta", toolCalls: [{ id: "t1", name: "f", rawArgumentsText: '{"a":' }] }),
          data({ type: "tool_call_delta", toolCalls: [{ id: "t1", rawArgumentsText: "1}" }] }),
          data({ type: "tool_use_end", toolCalls: [{ id: "t1", arguments: { a: 1 } }] }),
          data({ type: "done", ok: true, usage: { inputTokens: 1, outputTokens: 1 } }),
        ]),
        "m",
        true
      )
    );
    const reasoning = events
      .map((event) => (choice(event).delta as Json).reasoning_content)
      .filter((value): value is string => typeof value === "string")
      .join("");
    assert.equal(reasoning, "why");
    assert.equal(choice(events.at(-1)!).finish_reason, "tool_calls");
  });

  it("streams an error message and skips malformed lines", async () => {
    const events = await collect(
      perchSseToChatStream(
        source([
          "data: not json",
          ": comment",
          "",
          data({ type: "done", ok: false, error: "bad request" }),
        ]),
        "m",
        false
      )
    );
    const content = events
      .map((event) => (choice(event).delta as Json).content)
      .filter((value): value is string => typeof value === "string")
      .join("");
    assert.equal(content, "bad request");
  });
});
