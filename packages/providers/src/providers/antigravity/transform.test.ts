import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AntigravityProvider } from "#providers/providers/antigravity/provider.ts";
import {
  geminiDeltas,
  geminiFinishReason,
  geminiRetiredModelResponse,
  geminiSseToOpenAiStream,
  geminiStreamToOpenAiCompletionImpl,
  geminiToOpenAiCompletion,
  geminiUsage,
  normalizeToolCallArgs,
  peekRetiredNotice,
  processEscapeSequencesOnly,
  retiredResponse,
  stripToolCallIndexes,
  unwrapGeminiResponse,
  wrapCodeAssistPayload,
} from "#providers/providers/antigravity/transform.ts";

type Json = Record<string, unknown>;

function fakeProvider(): AntigravityProvider {
  return { cacheSignaturesFromResponse: async () => undefined } as unknown as AntigravityProvider;
}

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
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

function choice(event: Json): Json {
  return (event.choices as Json[])[0]!;
}

describe("escape and argument helpers", () => {
  it("processes escape sequences", () => {
    assert.equal(processEscapeSequencesOnly("a\\nb"), "a\nb");
    assert.equal(processEscapeSequencesOnly(5), 5);
    assert.equal(processEscapeSequencesOnly('a\\"b'), 'a\\"b');
    assert.equal(processEscapeSequencesOnly("a\\\\b"), "a\\\\b");
  });

  it("normalizes tool arguments by schema", () => {
    const schemas = { f: { s: { typ: "string" }, arr: { typ: "array" }, obj: { typ: "object" }, n: { typ: "number" } } };
    const result = normalizeToolCallArgs({ s: "a\\nb", arr: "[1,2]", obj: '{"a":1}', n: "5", x: "y" }, "f", schemas);
    assert.deepEqual(result, { s: "a\nb", arr: [1, 2], obj: { a: 1 }, n: "5", x: "y" });

    assert.equal(normalizeToolCallArgs("raw", "f", schemas), "raw");
    const broken = normalizeToolCallArgs({ arr: "[" }, "f", schemas) as Json;
    assert.equal(broken.arr, "[");
  });
});

describe("gemini response helpers", () => {
  it("unwraps responses", () => {
    assert.deepEqual(unwrapGeminiResponse({ response: { a: 1 } }), { a: 1 });
    assert.deepEqual(unwrapGeminiResponse([{ response: { a: 1 } }]), { a: 1 });
    assert.deepEqual(unwrapGeminiResponse({ a: 1 }), { a: 1 });
    assert.deepEqual(unwrapGeminiResponse([{}, {}]), {});
  });

  it("detects retired model notices", () => {
    const response = { candidates: [{ content: { parts: [{ text: "Gemini X is no longer available. Please switch to Y" }] } }] };
    assert.match(geminiRetiredModelResponse(response) ?? "", /no longer available/);
    assert.equal(geminiRetiredModelResponse({ candidates: [] }), null);
    assert.equal(geminiRetiredModelResponse({ candidates: [{ content: { parts: [{ text: "hi" }] } }] }), null);
  });

  it("wraps code assist payloads", () => {
    const wrapped = wrapCodeAssistPayload("p1", "m", { contents: [] });
    assert.equal(wrapped.project, "p1");
    assert.equal(wrapped.model, "m");
    assert.equal(wrapped.requestType, "agent");
    assert.match(String(wrapped.requestId), /^agent-[0-9a-f-]{36}$/);
  });

  it("builds retired responses", async () => {
    const resp = retiredResponse("gone");
    assert.equal(resp.status, 404);
    assert.deepEqual(await resp.json(), { error: { code: 404, message: "gone", status: "NOT_FOUND" } });
  });

  it("peeks for retired notices", async () => {
    const retired = await peekRetiredNotice(
      new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"Gemini X is no longer available. Please switch to Y"}]}}]}}\n')
    );
    assert.equal(retired.retired, true);
    assert.equal(retired.body, null);

    const source = 'data: {"response":{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}}\n';
    const live = await peekRetiredNotice(new Response(source));
    assert.equal(live.retired, false);
    assert.equal(await new Response(live.body!).text(), source);

    const empty = await peekRetiredNotice(new Response(null));
    assert.equal(empty.body, null);
  });

  it("extracts deltas and usage", () => {
    const toolIndex = { value: 0 };
    const deltas = geminiDeltas(
      {
        candidates: [
          {
            content: {
              parts: [
                { text: "hi" },
                { text: "why", thought: true },
                { functionCall: { name: "f", args: { a: 1 } } },
              ],
            },
          },
        ],
      },
      { f: { a: { typ: "number" } } },
      toolIndex
    );
    assert.deepEqual(deltas[0], { content: "hi" });
    assert.deepEqual(deltas[1], { reasoning_content: "why" });
    assert.equal(((deltas[2]!.tool_calls as Json[])[0]!.function as Json).arguments, '{"a":1}');

    const usage = geminiUsage({
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7, cachedContentTokenCount: 1, thoughtsTokenCount: 2 },
    });
    assert.deepEqual(usage, {
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 7,
      prompt_tokens_details: { cached_tokens: 1 },
      completion_tokens_details: { reasoning_tokens: 2 },
    });
    assert.equal(geminiUsage({}), null);
  });

  it("maps finish reasons", () => {
    assert.equal(geminiFinishReason({ candidates: [{ finishReason: "MAX_TOKENS" }] }, false), "length");
    assert.equal(geminiFinishReason({ candidates: [{ finishReason: "TOOL_CALLS" }] }, false), "tool_calls");
    assert.equal(geminiFinishReason({ candidates: [{ finishReason: "STOP" }] }, false), "stop");
    assert.equal(geminiFinishReason({ candidates: [{ finishReason: "STOP" }] }, true), "tool_calls");
    assert.equal(geminiFinishReason({ candidates: [] }, false), null);
  });

  it("builds chat completions and strips tool indexes", () => {
    const completion = geminiToOpenAiCompletion(
      {
        candidates: [{ content: { parts: [{ text: "hi" }, { functionCall: { id: "c1", name: "f", args: { a: 1 } } }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      },
      "m",
      {}
    );
    const message = choice(completion).message as Json;
    assert.equal(message.content, "hi");
    assert.equal(((message.tool_calls as Json[])[0]!.function as Json).name, "f");
    assert.equal("index" in ((message.tool_calls as Json[])[0] as Json), false);
    assert.equal(choice(completion).finish_reason, "tool_calls");

    assert.deepEqual(stripToolCallIndexes([{ index: 1, id: "a" }, "raw"]), [{ id: "a" }, "raw"]);
  });
});

describe("gemini streams", () => {
  it("streams chat chunks", async () => {
    const events = await collect(
      geminiSseToOpenAiStream(
        fakeProvider(),
        streamOf([
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}}\n\n',
          'data: {"response":{"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}}\n\n',
          "data: [DONE]\n\n",
        ]),
        "m",
        "s",
        {}
      )
    );
    assert.equal(((choice(events[0]!).delta as Json).role), "assistant");
    assert.equal(events.some((event) => choice(event).finish_reason === "stop"), true);
    assert.equal(events.some((event) => (event.usage as Json | undefined)?.total_tokens === 2), true);
  });

  it("aggregates streamed completions", async () => {
    const completion = await geminiStreamToOpenAiCompletionImpl(
      fakeProvider(),
      streamOf([
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}}\n\n',
        'data: {"response":{"candidates":[{"content":{"parts":[]},"finishReason":"MAX_TOKENS"}]}}\n\n',
      ]),
      "m",
      "s",
      {}
    );
    assert.equal((choice(completion).message as Json).content, "hi");
    assert.equal(choice(completion).finish_reason, "length");
  });

  it("throws on retired models", async () => {
    await assert.rejects(
      geminiStreamToOpenAiCompletionImpl(
        fakeProvider(),
        streamOf(['data: {"response":{"candidates":[{"content":{"parts":[{"text":"Gemini X is no longer available. Please switch to Y"}]}}]}}\n\n']),
        "m",
        "s",
        {}
      ),
      /retired/
    );
  });
});
