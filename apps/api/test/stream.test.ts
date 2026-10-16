import { describe, expect, it } from "bun:test";
import { anthropicStream, passthroughNonStream, passthroughStream } from "../core/stream.js";
import type { ResponseContext, StreamRecorder, UsageCounts } from "../core/types.js";

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

async function readBodyText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    text += decoder.decode(result.value, { stream: true });
  }
  return text + decoder.decode();
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
      recordSuccess(params) {
        recorded.push({ inputTokens: params.inputTokens, outputTokens: params.outputTokens, stream: params.stream });
      },
      storeCredits(accountId, remaining, cost) {
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
    expect(ctx.streamHandled).toBe(true);
    const text = await response.text();
    expect(text).toMatch(/hel/);
    expect(text).toMatch(/lo/);
    expect(response.headers.get("x-provider-account-id")).toBe("acc-1");
    expect(usage.inputTokens).toBe(5);
    expect(usage.outputTokens).toBe(2);
    expect(recorded.length).toBe(1);
    expect(recorded[0].stream).toBe(true);
    expect(completion).toBe("success");
  });

  it("reports an error completion instead of recording success", async () => {
    let completion = "";
    const ctx = context(sseResponseThenError('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', new Error("boom")));
    ctx.onStreamComplete = (reason) => {
      completion = reason;
    };
    const { recorder: rec, recorded } = recorder();
    const response = await passthroughStream(ctx, rec);
    await expect(response.text()).rejects.toThrow();
    expect(completion).toBe("error");
    expect(recorded.length).toBe(0);
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
    expect(reader).toBeTruthy();
    if (!reader) return;
    await reader.read();
    await reader.cancel();
    expect(completion).toBe("cancel");
    expect(recorded.length).toBe(0);
  });

  it("records hypercredits for hyper", async () => {
    const ctx = context(
      sseResponse(['data: {"usage":{"remaining":{"hypercredits":12.5},"cost":{"hypercredits":1.5}}}\n\n']),
      "hyper"
    );
    const { recorder: rec, hypercredits } = recorder();
    await (await passthroughStream(ctx, rec)).text();
    expect(hypercredits).toEqual([{ accountId: "acc-1", remaining: 12.5, cost: 1.5 }]);
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
    expect(response.status).toBe(200);
    expect(usage.inputTokens).toBe(9);
    expect(usage.cachedTokens).toBe(1);
    expect(recorded[0].stream).toBe(false);
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
    const text = await readBodyText(response);
    expect(text).toMatch(/event: message_start/);
    expect(text).toMatch(/event: content_block_start/);
    expect(text).toMatch(/"type":"thinking_delta"/);
    expect(text).toMatch(/"type":"text_delta"/);
    expect(text).toMatch(/"type":"tool_use"/);
    expect(text).toMatch(/"stop_reason":"tool_use"/);
    expect(text).toMatch(/event: message_stop/);
  });
});
