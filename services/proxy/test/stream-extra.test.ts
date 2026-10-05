import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import {
  anthropicNonStream,
  anthropicStream,
  passthroughNonStream,
  passthroughStream,
} from "../src/core/streaming/stream.ts";
import type { ResponseContext, StreamRecorder, UsageCounts } from "../src/core/types.ts";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function recorder(): StreamRecorder {
  return { storeHypercreditsUsage: vi.fn(), recordSuccessfulRequest: vi.fn() } as unknown as StreamRecorder;
}

function context(overrides: Partial<ResponseContext> = {}): ResponseContext {
  const usage: UsageCounts = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
  const completed: string[] = [];
  const ctx: ResponseContext = {
    response: new Response("{}", { status: 200 }),
    accountId: "a1",
    provider: "openai",
    requestStartMs: Date.now(),
    upstreamFirstResponseMs: Date.now(),
    startMs: Date.now(),
    userId: "u1",
    apiKeyId: "k1",
    model: "m",
    usage,
    onStreamComplete: (reason) => completed.push(reason),
    ...overrides,
  };
  (ctx as unknown as { completed: string[] }).completed = completed;
  return ctx;
}

function completedOf(ctx: ResponseContext): string[] {
  return (ctx as unknown as { completed: string[] }).completed;
}

describe("passthroughNonStream", () => {
  it("records usage from JSON bodies", async () => {
    const rec = recorder();
    const ctx = context({ response: new Response(JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 1 } } })) });
    const response = await passthroughNonStream(ctx, rec);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-Provider-Account-Id"), "a1");
    assert.equal(ctx.usage.inputTokens, 5);
    assert.equal((rec.recordSuccessfulRequest as ReturnType<typeof vi.fn>).mock.calls.length, 1);
  });

  it("handles invalid JSON", async () => {
    const rec = recorder();
    const ctx = context({ response: new Response("not json") });
    await passthroughNonStream(ctx, rec);
    assert.equal(ctx.usage.inputTokens, 0);
  });

  it("reports hypercredits for hyper providers", async () => {
    const rec = recorder();
    const ctx = context({
      provider: "hyper",
      response: new Response(JSON.stringify({ usage: { remaining: { hypercredits: 10 }, cost: { hypercredits: 2 } } })),
    });
    await passthroughNonStream(ctx, rec);
    assert.equal((rec.storeHypercreditsUsage as ReturnType<typeof vi.fn>).mock.calls.length, 1);
  });
});

describe("anthropicNonStream", () => {
  it("converts chat completions", async () => {
    const rec = recorder();
    const ctx = context({ response: new Response(JSON.stringify({ id: "c1", choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })) });
    const response = await anthropicNonStream(ctx, rec);
    const body = (await response.json()) as { type: string };
    assert.equal(body.type, "message");
    assert.equal((rec.recordSuccessfulRequest as ReturnType<typeof vi.fn>).mock.calls.length, 1);
  });

  it("handles invalid JSON", async () => {
    const rec = recorder();
    const ctx = context({ response: new Response("nope") });
    await anthropicNonStream(ctx, rec);
    assert.equal(ctx.usage.outputTokens, 0);
  });
});

describe("passthroughStream", () => {
  it("streams and records success", async () => {
    const rec = recorder();
    const ctx = context({ response: new Response(streamOf(['data: {"usage":{"prompt_tokens":5,"completion_tokens":3}}\n\n'])) });
    const response = await passthroughStream(ctx, rec);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(await response.text(), 'data: {"usage":{"prompt_tokens":5,"completion_tokens":3}}\n\n');
    assert.equal(ctx.usage.inputTokens, 5);
    assert.equal(completedOf(ctx).includes("success"), true);
    assert.equal((rec.recordSuccessfulRequest as ReturnType<typeof vi.fn>).mock.calls.length, 1);
  });

  it("stores hypercredits for hyper providers", async () => {
    const rec = recorder();
    const ctx = context({
      provider: "hyper",
      response: new Response(streamOf(['data: {"usage":{"remaining":{"hypercredits":10}}}\n\n'])),
    });
    const response = await passthroughStream(ctx, rec);
    await response.text();
    assert.equal((rec.storeHypercreditsUsage as ReturnType<typeof vi.fn>).mock.calls.length, 1);
  });

  it("handles missing bodies and cancellation", async () => {
    const rec = recorder();
    const empty = context({ response: new Response(null) });
    assert.equal(await passthroughStream(empty, rec), empty.response);

    const ctx = context({ response: new Response(streamOf(["data: x\n\n"])) });
    const response = await passthroughStream(ctx, rec);
    await response.body!.cancel();
    assert.equal(completedOf(ctx).includes("cancel"), true);
    assert.equal((rec.recordSuccessfulRequest as ReturnType<typeof vi.fn>).mock.calls.length, 0);
  });

  it("reports read errors and tolerates cancel failures", async () => {
    const rec = recorder();
    const failing = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("read failed");
      },
    });
    const ctx = context({ response: new Response(failing) });
    const response = await passthroughStream(ctx, rec);
    await assert.rejects(response.text(), /upstream stream failed/);
    assert.equal(completedOf(ctx).includes("error"), true);

    const cancelFails = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: x\n\n"));
      },
      cancel() {
        throw new Error("cancel failed");
      },
    });
    const ctx2 = context({ response: new Response(cancelFails) });
    const response2 = await passthroughStream(ctx2, rec);
    await response2.body!.cancel();
    assert.equal(completedOf(ctx2).includes("cancel"), true);
  });
});

describe("anthropicStream", () => {
  it("emits anthropic events", async () => {
    const rec = recorder();
    const ctx = context({
      response: new Response(streamOf(['data: {"id":"c1","choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n'])),
    });
    const response = await anthropicStream(ctx, rec);
    const text = await response.text();
    assert.match(text, /event: message_start/);
    assert.match(text, /event: message_stop/);
    assert.equal((rec.recordSuccessfulRequest as ReturnType<typeof vi.fn>).mock.calls.length, 1);
  });

  it("supports kiro providers and cancellation", async () => {
    const rec = recorder();
    const empty = context({ response: new Response(null), provider: "kiro" });
    assert.equal(await anthropicStream(empty, rec), empty.response);

    const ctx = context({ provider: "kiro", response: new Response(streamOf(["data: {}\n\n"])) });
    const response = await anthropicStream(ctx, rec);
    await response.body!.cancel();
    assert.equal(completedOf(ctx).includes("cancel"), true);
  });

  it("reports read errors", async () => {
    const rec = recorder();
    const failing = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("read failed");
      },
    });
    const ctx = context({ response: new Response(failing) });
    const response = await anthropicStream(ctx, rec);
    await assert.rejects(response.text(), /upstream stream failed/);
    assert.equal(completedOf(ctx).includes("error"), true);
  });

  it("tolerates cancel failures", async () => {
    const rec = recorder();
    const cancelFails = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
      },
      cancel() {
        throw new Error("cancel failed");
      },
    });
    const ctx = context({ response: new Response(cancelFails) });
    const response = await anthropicStream(ctx, rec);
    await response.body!.cancel();
    assert.equal(completedOf(ctx).includes("cancel"), true);
  });
});
