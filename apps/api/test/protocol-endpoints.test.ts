import { describe, expect, it } from "bun:test";
import { Messages, Responses } from "@opendum/api/core/endpoints";
import { protocolResponse, protocolStream } from "@opendum/api/core/protocol-stream";
import { routeFailure, type ResponseContext, type StreamRecorder, type UsageCounts } from "@opendum/api/core/types";

const encoder = new TextEncoder();

function sseResponse(chunks: ReadonlyArray<string>): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function context(response: Response, usage: UsageCounts): ResponseContext {
  return {
    response,
    accountId: "acc-1",
    provider: "openai",
    requestStartMs: Date.now() - 10,
    firstResponseMs: Date.now(),
    startMs: Date.now() - 20,
    userId: "user-1",
    apiKeyId: "key-1",
    model: "gpt-4o",
    usage,
  };
}

function recorder(): { recorder: StreamRecorder; recorded: Array<{ stream: boolean; inputTokens: number }> } {
  const recorded: Array<{ stream: boolean; inputTokens: number }> = [];
  return {
    recorded,
    recorder: {
      recordSuccess(params) {
        recorded.push({ stream: params.stream, inputTokens: params.inputTokens });
      },
      storeCredits() {
        return undefined;
      },
    },
  };
}

function usage(): UsageCounts {
  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
}

const chatChunks = [
  'data: {"id":"c1","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"why"}}]}\n\n',
  'data: {"id":"c1","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
  'data: {"id":"c1","model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"do","arguments":"{}"}}]}}]}\n\n',
  'data: {"id":"c1","model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
  "data: [DONE]\n\n",
];

describe("messages endpoint", () => {
  it("builds a chat payload from an anthropic request", () => {
    const adapter = new Messages();
    const parsed = adapter.parse({
      model: "claude",
      max_tokens: 128,
      system: "be nice",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [{ name: "do", input_schema: { type: "object" } }],
      tool_choice: { type: "any" },
    });
    expect(routeFailure(parsed)).toBe(false);
    if (routeFailure(parsed)) return;
    const payload = adapter.build(parsed, "claude", false, "sess-1");
    const messages = payload.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: "system", content: "be nice" });
    expect(messages[1]).toEqual({ role: "user", content: "hello" });
    expect(payload.max_tokens).toBe(128);
    expect(payload.tool_choice).toBe("required");
    expect(payload._sessionId).toBe("sess-1");
    expect((payload.tools as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: "function",
      function: { name: "do" },
    });
  });

  it("converts a chat completion into an anthropic message", async () => {
    const counts = usage();
    const { recorder: rec, recorded } = recorder();
    const response = await protocolResponse(context(new Response(JSON.stringify({
      id: "c1",
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "hi", reasoning_content: "why", tool_calls: [{ id: "call_1", type: "function", function: { name: "do", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    }), { status: 200 }), counts), rec, { from: "chat", to: "messages", model: "claude" });
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.type).toBe("message");
    expect(body.stop_reason).toBe("tool_use");
    const content = body.content as Array<Record<string, unknown>>;
    expect(content.map((block) => block.type)).toEqual(["thinking", "text", "tool_use"]);
    expect(counts.inputTokens).toBe(5);
    expect(recorded[0]).toEqual({ stream: false, inputTokens: 5 });
  });

  it("converts a chat stream into anthropic events", async () => {
    const counts = usage();
    const { recorder: rec, recorded } = recorder();
    const ctx = context(sseResponse(chatChunks), counts);
    const response = await protocolStream(ctx, rec, { from: "chat", to: "messages", model: "claude" });
    const text = await response.text();
    expect(text).toMatch(/event: message_start/);
    expect(text).toMatch(/"type":"thinking_delta"/);
    expect(text).toMatch(/"type":"text_delta"/);
    expect(text).toMatch(/"type":"tool_use"/);
    expect(text).toMatch(/"stop_reason":"tool_use"/);
    expect(text).toMatch(/event: message_stop/);
    expect(counts.inputTokens).toBe(5);
    expect(recorded[0]).toEqual({ stream: true, inputTokens: 5 });
  });
});

describe("responses endpoint", () => {
  it("builds a chat payload from a responses request", () => {
    const adapter = new Responses();
    const parsed = adapter.parse({
      model: "gpt-4o",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "function_call", call_id: "fc_1", name: "do", arguments: "{}" },
        { type: "function_call_output", call_id: "fc_1", output: "ok" },
      ],
      instructions: "sys",
      max_output_tokens: 64,
      tools: [{ type: "function", name: "do", parameters: { type: "object" } }],
    });
    expect(routeFailure(parsed)).toBe(false);
    if (routeFailure(parsed)) return;
    const payload = adapter.build(parsed, "gpt-4o", false, "");
    const messages = payload.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: "system", content: "sys" });
    expect(messages[1]).toEqual({ role: "user", content: "hi" });
    expect(messages[2]).toMatchObject({ role: "assistant", content: null });
    expect(messages[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "ok" });
    expect(payload.max_tokens).toBe(64);
    expect(payload.instructions).toBe("sys");
    expect(payload._responsesInput).toBeArray();
  });

  it("converts a chat completion into a responses object", async () => {
    const counts = usage();
    const { recorder: rec } = recorder();
    const response = await protocolResponse(context(new Response(JSON.stringify({
      id: "c1",
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "hi", reasoning_content: "why" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    }), { status: 200 }), counts), rec, { from: "chat", to: "responses", model: "gpt-4o" });
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.object).toBe("response");
    const output = body.output as Array<Record<string, unknown>>;
    expect(output.map((item) => item.type)).toEqual(["reasoning", "message"]);
  });

  it("converts a chat stream into responses events", async () => {
    const counts = usage();
    const { recorder: rec } = recorder();
    const response = await protocolStream(context(sseResponse(chatChunks), counts), rec, {
      from: "chat",
      to: "responses",
      model: "gpt-4o",
    });
    const text = await response.text();
    expect(text).toMatch(/"type":"response.created"/);
    expect(text).toMatch(/"type":"response.reasoning_summary_text.delta"/);
    expect(text).toMatch(/"type":"response.output_text.delta"/);
    expect(text).toMatch(/"type":"response.function_call_arguments.delta"/);
    expect(text).toMatch(/"type":"response.completed"/);
    expect(counts.inputTokens).toBe(5);
  });
});
