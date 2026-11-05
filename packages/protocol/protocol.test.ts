import { describe, expect, it } from "bun:test";
import { decodeRequest as decodeAnthropicRequest, encodeRequest as encodeAnthropicRequest } from "@opendum/protocol/anthropic/codec";
import { decodeRequest as decodeChatRequest, encodeRequest as encodeChatRequest } from "@opendum/protocol/openai/chat-codec";
import { decodeRequest as decodeResponsesRequest, encodeRequest as encodeResponsesRequest } from "@opendum/protocol/openai/responses-codec";
import { decodeRequest, decodeResponse, encodeRequest, encodeResponse } from "@opendum/protocol/upstream";
import { SseDecoder } from "@opendum/protocol/sse";
import { fromAnthropicUsage, fromChatUsage, fromResponsesUsage, toChatUsage, toResponsesUsage } from "@opendum/protocol/usage";
import type { IrRequest } from "@opendum/protocol/ir";

function sseChunks(text: string): string[] {
  const decoder = new SseDecoder();
  const events: string[] = [];
  decoder.process(text, (event) => events.push(event.data));
  decoder.flush((event) => events.push(event.data));
  return events;
}

describe("ir request decoding", () => {
  it("normalizes anthropic messages into the shared ir", () => {
    const request = decodeAnthropicRequest({
      model: "claude",
      max_tokens: 256,
      system: "be brief",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "do", input: { a: 1 } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
      ],
      tools: [{ name: "do", description: "run", input_schema: { type: "object" } }],
      tool_choice: { type: "any" },
      thinking: { type: "enabled", budget_tokens: 2048 },
      stream: true,
    });
    expect(request.model).toBe("claude");
    expect(request.sampling.maxTokens).toBe(256);
    expect(request.messages[0]?.role).toBe("system");
    expect(request.toolChoice).toBe("required");
    expect(request.reasoning).toEqual({ mode: "budget", budget: 2048 });
    expect(request.tools[0]?.name).toBe("do");
    expect(request.stream).toBe(true);
  });

  it("normalizes chat completions into the shared ir", () => {
    const request = decodeChatRequest({
      model: "gpt",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "https://x/y.png" } }] },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "do", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
      ],
      reasoning_effort: "high",
      tool_choice: { type: "function", function: { name: "do" } },
    });
    expect(request.messages).toHaveLength(4);
    expect(request.messages[1]?.content[1]).toEqual({ type: "image", source: "url", url: "https://x/y.png" });
    expect(request.messages[2]?.content[0]).toEqual({
      type: "tool_call",
      id: "call_1",
      name: "do",
      arguments: "{}",
    });
    expect(request.reasoning).toEqual({ mode: "effort", effort: "high" });
    expect(request.toolChoice).toEqual({ name: "do" });
  });

  it("normalizes responses items into the shared ir", () => {
    const request = decodeResponsesRequest({
      model: "gpt",
      instructions: "sys",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "reasoning", summary: [{ type: "summary_text", text: "why" }] },
        { type: "function_call", call_id: "fc_1", name: "do", arguments: "{}" },
        { type: "function_call_output", call_id: "fc_1", output: "ok" },
      ],
      reasoning: { effort: "medium" },
      max_output_tokens: 64,
    });
    expect(request.sampling.maxTokens).toBe(64);
    expect(request.messages[0]).toEqual({ role: "system", content: [{ type: "text", text: "sys" }] });
    expect(request.messages[2]?.content).toEqual([
      { type: "reasoning", text: "why" },
      { type: "tool_call", id: "call_1", name: "do", arguments: "{}" },
    ]);
    expect(request.messages[3]?.content[0]).toMatchObject({ type: "tool_result", toolCallId: "call_1" });
  });
});

describe("ir request encoding", () => {
  const request: IrRequest = {
    model: "m",
    messages: [
      { role: "system", content: [{ type: "text", text: "sys" }] },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_call", id: "call_1", name: "do", arguments: "{}" }] },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "call_1", content: [{ type: "text", text: "ok" }] }] },
    ],
    tools: [{ name: "do", description: "run", parameters: { type: "object" } }],
    sampling: { maxTokens: 32, temperature: 0.5 },
    stream: true,
    metadata: {},
  };

  it("encodes chat completions", () => {
    const body = encodeChatRequest(request);
    expect(body.model).toBe("m");
    expect(body.max_tokens).toBe(32);
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: "system", content: "sys" });
    expect(messages[2]).toMatchObject({ role: "assistant", content: null });
    expect(messages[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "ok" });
    expect((body.tools as unknown[]).length).toBe(1);
  });

  it("encodes anthropic messages", () => {
    const body = encodeAnthropicRequest(request);
    expect(body.system).toBe("sys");
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.role).toBe("user");
    const assistant = messages[1]?.content as Array<Record<string, unknown>>;
    expect(assistant[0]).toMatchObject({ type: "tool_use" });
    const toolResult = messages[2]?.content as Array<Record<string, unknown>>;
    expect(toolResult[0]).toMatchObject({ type: "tool_result" });
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[0]?.input_schema).toEqual({ type: "object" });
  });

  it("lifts anthropic tool results into tool messages", () => {
    const ir = decodeRequest("messages", {
      model: "claude",
      max_tokens: 16,
      messages: [
        { role: "user", content: "find cats" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "search", input: { q: "cats" } }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "many cats" }] },
      ],
    });
    const body = encodeChatRequest(ir);
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages.at(-1)).toEqual({ role: "tool", tool_call_id: "toolu_1", content: "many cats" });
    expect(messages.some((message) => message.role === "user" && message.content === "")).toBe(false);
  });

  it("encodes responses", () => {
    const body = encodeResponsesRequest(request);
    expect(body.instructions).toBe("sys");
    expect(body.max_output_tokens).toBe(32);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[1]).toMatchObject({ type: "function_call", call_id: "fc_1" });
    expect(input[2]).toMatchObject({ type: "function_call_output", call_id: "fc_1" });
  });
});

describe("ir response conversion", () => {
  const chat = {
    id: "chatcmpl-1",
    model: "gpt",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "hi",
          reasoning_content: "why",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "do", arguments: "{}" } }],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 4, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 1 } },
  };

  it("decodes chat completions into the ir", () => {
    const response = decodeResponse("chat", chat, "gpt");
    expect(response.finishReason).toBe("tool_calls");
    expect(response.usage).toEqual({
      inputTokens: 4,
      outputTokens: 2,
      cachedTokens: 1,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });
    expect(response.content.map((part) => part.type)).toEqual(["reasoning", "text", "tool_call"]);
  });

  it("encodes the ir as anthropic messages", () => {
    const response = decodeResponse("chat", chat, "gpt");
    const body = encodeResponse("messages", response) as Record<string, unknown>;
    expect(body.type).toBe("message");
    expect(body.stop_reason).toBe("tool_use");
    const content = body.content as Array<Record<string, unknown>>;
    expect(content.map((block) => block.type)).toEqual(["thinking", "text", "tool_use"]);
    expect(body.usage).toMatchObject({ input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 1 });
  });

  it("encodes the ir as a responses object", () => {
    const response = decodeResponse("chat", chat, "gpt");
    const body = encodeResponse("responses", response) as Record<string, unknown>;
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    const output = body.output as Array<Record<string, unknown>>;
    expect(output.map((item) => item.type)).toEqual(["reasoning", "message", "function_call"]);
  });
});

describe("cross dialect request round trip", () => {
  it("carries an anthropic request through chat and back", () => {
    const ir = decodeRequest("messages", {
      model: "claude",
      max_tokens: 16,
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "do", input_schema: { type: "object" } }],
      tool_choice: { type: "tool", name: "do" },
    });
    const chat = encodeRequest("chat", ir);
    const reparsed = decodeRequest("chat", chat);
    expect(reparsed.messages[0]).toEqual({ role: "system", content: [{ type: "text", text: "sys" }] });
    expect(reparsed.toolChoice).toEqual({ name: "do" });
    expect(reparsed.sampling.maxTokens).toBe(16);
    const back = encodeRequest("messages", reparsed);
    expect(back.tool_choice).toEqual({ type: "tool", name: "do" });
  });

  it("carries a responses request through anthropic and back", () => {
    const ir = decodeRequest("responses", {
      model: "gpt",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [{ type: "function", name: "do", parameters: { type: "object" } }],
    });
    const anthropic = encodeRequest("messages", ir);
    const reparsed = decodeRequest("messages", anthropic);
    expect(reparsed.tools[0]?.name).toBe("do");
    const back = encodeRequest("responses", reparsed);
    expect((back.tools as Array<Record<string, unknown>>)[0]?.name).toBe("do");
  });
});

describe("sse decoding", () => {
  it("handles multi line data and named events", () => {
    const events = sseChunks("event: ping\ndata: a\ndata: b\n\n:comment\ndata: c\n\n");
    expect(events).toEqual(["a\nb", "c"]);
  });

  it("keeps partial events across chunks", () => {
    const decoder = new SseDecoder();
    const events: string[] = [];
    decoder.process('data: {"a"', (event) => events.push(event.data));
    decoder.process(':1}\n\n', (event) => events.push(event.data));
    expect(events).toEqual(['{"a":1}']);
  });
});

describe("usage mapping", () => {
  it("maps every dialect into the ir", () => {
    expect(fromChatUsage({ prompt_tokens: 5, completion_tokens: 2 })).toMatchObject({
      inputTokens: 5,
      outputTokens: 2,
    });
    expect(fromResponsesUsage({ input_tokens: 5, output_tokens: 2 })).toMatchObject({
      inputTokens: 5,
      outputTokens: 2,
    });
    expect(
      fromAnthropicUsage({ input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 1 })
    ).toMatchObject({ inputTokens: 5, cachedTokens: 1 });
  });

  it("maps the ir back into every dialect", () => {
    const usage = { inputTokens: 5, outputTokens: 2, cachedTokens: 1, cacheWriteTokens: 0, reasoningTokens: 0 };
    expect(toChatUsage(usage)).toMatchObject({ prompt_tokens: 5, total_tokens: 7 });
    expect(toResponsesUsage(usage)).toMatchObject({ input_tokens: 5, total_tokens: 7 });
  });
});
