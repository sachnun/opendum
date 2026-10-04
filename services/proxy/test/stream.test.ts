import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { anthropicStream, passthroughNonStream, passthroughStream } from "../src/core/stream.js";
import type { ResponseContext, StreamRecorder, UsageCounts } from "../src/core/types.js";

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function sseResponseThenError(chunk: string, error: Error): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(chunk));
    },
    pull(controller) {
      controller.error(error);
    },
  });
  return new Response(body, { status: 200 });
}

function context(response: Response, provider = "openai", usage?: UsageCounts): ResponseContext {
  return {
    response,
    accountId: "acc-1",
    provider,
    requestStartMs: Date.now() - 10,
    upstreamFirstResponseMs: Date.now(),
    startMs: Date.now() - 20,
    userId: "user-1",
    apiKeyId: "key-1",
    model: "gpt-4o",
    usage: usage ?? { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 },
  };
}

function recorder(): { recorder: StreamRecorder; recorded: Array<{ inputTokens: number; outputTokens: number; stream: boolean }>; hypercredits: Array<{ accountId: string; remaining: number | null; cost: number }> } {
  const recorded: Array<{ inputTokens: number; outputTokens: number; stream: boolean }> = [];
  const hypercredits: Array<{ accountId: string; remaining: number | null; cost: number }> = [];
  return {
    recorded,
    hypercredits,
    recorder: {
      recordSuccessfulRequest(params) {
        recorded.push({ inputTokens: params.inputTokens, outputTokens: params.outputTokens, stream: params.stream });
      },
      storeHypercreditsUsage(accountId, remaining, cost) {
        hypercredits.push({ accountId, remaining, cost });
      },
    },
  };
}

describe("passthroughStream", () => {
  it("forwards chunks and records usage", async () => {
    const usage: UsageCounts = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
    let completion = "";
    const ctx = context(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
        "data: [DONE]\n\n",
      ]),
      "openai",
      usage
    );
    ctx.onStreamComplete = (reason) => {
      completion = reason;
    };
    const { recorder: rec, recorded } = recorder();
    const response = await passthroughStream(ctx, rec);
    assert.equal(ctx.streamHandled, true);
    const text = await response.text();
    assert.match(text, /hel/);
    assert.match(text, /lo/);
    assert.equal(response.headers.get("x-provider-account-id"), "acc-1");
    assert.equal(usage.inputTokens, 5);
    assert.equal(usage.outputTokens, 2);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].stream, true);
    assert.equal(completion, "success");
  });

  it("reports an error completion instead of recording success", async () => {
    let completion = "";
    const ctx = context(sseResponseThenError('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', new Error("boom")));
    ctx.onStreamComplete = (reason) => {
      completion = reason;
    };
    const { recorder: rec, recorded } = recorder();
    const response = await passthroughStream(ctx, rec);
    await assert.rejects(async () => {
      await response.text();
    });
    assert.equal(completion, "error");
    assert.equal(recorded.length, 0);
  });

  it("reports a cancel completion when the client disconnects", async () => {
    let completion = "";
    const ctx = context(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        "data: [DONE]\n\n",
      ])
    );
    ctx.onStreamComplete = (reason) => {
      completion = reason;
    };
    const { recorder: rec, recorded } = recorder();
    const response = await passthroughStream(ctx, rec);
    const reader = response.body?.getReader();
    assert.ok(reader);
    await reader.read();
    await reader.cancel();
    assert.equal(completion, "cancel");
    assert.equal(recorded.length, 0);
  });

  it("records hypercredits for hyper", async () => {
    const ctx = context(
      sseResponse(['data: {"usage":{"remaining":{"hypercredits":12.5},"cost":{"hypercredits":1.5}}}\n\n']),
      "hyper"
    );
    const { recorder: rec, hypercredits } = recorder();
    await (await passthroughStream(ctx, rec)).text();
    assert.deepEqual(hypercredits, [{ accountId: "acc-1", remaining: 12.5, cost: 1.5 }]);
  });
});

describe("passthroughNonStream", () => {
  it("records json usage", async () => {
    const usage: UsageCounts = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
    const ctx = context(
      new Response(
        JSON.stringify({
          choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 9, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 1 } },
        }),
        { status: 200 }
      ),
      "openai",
      usage
    );
    const { recorder: rec, recorded } = recorder();
    const response = await passthroughNonStream(ctx, rec);
    assert.equal(response.status, 200);
    assert.equal(usage.inputTokens, 9);
    assert.equal(usage.cachedTokens, 1);
    assert.equal(recorded[0].stream, false);
  });
});

describe("anthropicStream", () => {
  it("emits anthropic events from chat chunks", async () => {
    const ctx = context(
      sseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"do","arguments":"{}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      ]),
      "kiro"
    );
    const { recorder: rec } = recorder();
    const response = await anthropicStream(ctx, rec);
    const text = await response.text();
    assert.match(text, /event: message_start/);
    assert.match(text, /event: content_block_start/);
    assert.match(text, /"type":"thinking_delta"/);
    assert.match(text, /"type":"text_delta"/);
    assert.match(text, /"type":"tool_use"/);
    assert.match(text, /"stop_reason":"tool_use"/);
    assert.match(text, /event: message_stop/);
  });
});
