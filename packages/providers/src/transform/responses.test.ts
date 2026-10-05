import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  adaptChatResponseToResponses,
  adaptForResponsesClient,
  buildResponsesApiPayload,
  chatCompletionToResponsesJson,
  chatSseToChatCompletion,
  clampPromptCacheKey,
  convertToolsForResponses,
  messagesToResponsesInput,
  normalizeResponsesContent,
  normalizeResponsesInput,
  responsesSseToResponsesJson,
} from "#providers/transform/responses.ts";

type Json = Record<string, unknown>;

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function text(resp: Response): Promise<string> {
  return await resp.text();
}

describe("messagesToResponsesInput", () => {
  it("maps chat roles to responses items", () => {
    const input = messagesToResponsesInput([
      { role: "system", content: "sys" },
      { role: "developer", content: "dev" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "assistant", content: "with tools", tool_calls: [{ id: "call_1", function: { name: "f", arguments: '{"a":1}' } }] },
      { role: "assistant", tool_calls: [{ id: "call_2", function: { name: "g" } }] },
      { role: "tool", tool_call_id: "call_1", content: "result" },
      { role: "weird", content: "x" },
    ]) as Json[];
    assert.equal((input[0] as Json).role, "developer");
    assert.equal((input[1] as Json).role, "developer");
    assert.equal((input[2] as Json).role, "user");
    assert.equal((input[3] as Json).role, "assistant");
    assert.equal((input[4] as Json).role, "assistant");
    assert.equal((input[5] as Json).type, "function_call");
    assert.equal((input[5] as Json).id, "fc_1");
    assert.equal((input[5] as Json).call_id, "fc_1");
    assert.equal((input[6] as Json).type, "function_call");
    assert.equal((input[7] as Json).type, "function_call_output");
    assert.equal((input[7] as Json).call_id, "fc_1");
  });
});

describe("normalizeResponsesInput", () => {
  it("infers and normalizes item types", () => {
    const out = normalizeResponsesInput([
      "raw",
      { summary: "s" },
      { encrypted_content: "e" },
      { call_id: "c", name: "f", arguments: "{}" },
      { call_id: "c2", output: "o" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]) as unknown[];
    assert.equal(out[0], "raw");
    assert.equal((out[1] as Json).type, "reasoning");
    assert.equal((out[2] as Json).type, "reasoning");
    assert.equal((out[3] as Json).type, "function_call");
    assert.equal((out[3] as Json).call_id, "fc_c");
    assert.equal((out[4] as Json).type, "function_call_output");
    assert.deepEqual((out[5] as Json).content, [{ type: "input_text", text: "hi" }]);
  });
});

describe("normalizeResponsesContent", () => {
  it("rewrites text and image parts", () => {
    assert.equal(normalizeResponsesContent("plain", "user"), "plain");
    const user = normalizeResponsesContent(
      [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "https://x", detail: "high" } }],
      "user"
    ) as Json[];
    assert.deepEqual(user[0], { type: "input_text", text: "hi" });
    assert.deepEqual(user[1], { type: "input_image", image_url: "https://x", detail: "high" });

    const assistant = normalizeResponsesContent([{ type: "text", text: "hi" }], "assistant") as Json[];
    assert.equal(assistant[0]!.type, "output_text");
  });
});

describe("convertToolsForResponses", () => {
  it("converts tool definitions", () => {
    assert.deepEqual(convertToolsForResponses("nope"), []);
    const tools = convertToolsForResponses([
      { type: "function", function: { name: "f", description: "d", parameters: { type: "object" }, strict: true } },
      { name: "g" },
      { function: {} },
    ]) as Json[];
    assert.equal(tools.length, 2);
    assert.deepEqual(tools[0], { type: "function", name: "f", description: "d", parameters: { type: "object" }, strict: true });
    assert.deepEqual(tools[1], { type: "function", name: "g", description: "", parameters: { type: "object", properties: {} } });
  });
});

describe("chatCompletionToResponsesJson", () => {
  it("converts a chat completion", () => {
    const response = chatCompletionToResponsesJson(
      {
        choices: [{ message: { content: "hi", reasoning_content: "why", tool_calls: [{ id: "t1", function: { name: "f", arguments: '{"a":1}' } }] }, finish_reason: "length" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      "m"
    );
    assert.equal(response.object, "response");
    assert.equal(response.status, "incomplete");
    assert.deepEqual(response.incomplete_details, { reason: "max_output_tokens" });
    assert.equal((response.output as unknown[]).length, 3);
    assert.equal(response.model, "m");
  });

  it("handles empty completions", () => {
    const response = chatCompletionToResponsesJson({}, "m");
    assert.equal(response.status, "completed");
    assert.deepEqual(response.output, []);
  });
});

describe("responsesSseToResponsesJson", () => {
  it("reads raw json and terminal SSE events", async () => {
    assert.deepEqual(await responsesSseToResponsesJson(streamOf(['{"id":"r1"}'])), { id: "r1" });
    const sse = await responsesSseToResponsesJson(
      streamOf(['data: {"type":"response.completed","response":{"id":"r2"}}\n\ndata: [DONE]\n'])
    );
    assert.deepEqual(sse, { id: "r2" });
  });

  it("throws without a terminal event", async () => {
    await assert.rejects(responsesSseToResponsesJson(streamOf(["data: [DONE]\n"])), /terminal event/);
  });
});

describe("chatSseToChatCompletion", () => {
  it("returns raw json bodies", async () => {
    const raw = await chatSseToChatCompletion(streamOf(['{"choices":[]}']), "m");
    assert.deepEqual(raw, { choices: [] });
  });

  it("aggregates streamed deltas", async () => {
    const completion = await chatSseToChatCompletion(
      streamOf([
        'data: {"choices":[{"delta":{"content":"hi","reasoning_content":"why"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"f","arguments":"{\\"a\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n",
      ]),
      "m"
    );
    const choice = (completion.choices as Json[])[0]!;
    const message = choice.message as Json;
    assert.equal(message.content, "hi");
    assert.equal(message.reasoning_content, "why");
    assert.deepEqual(message.tool_calls, [{ id: "t1", type: "function", function: { name: "f", arguments: '{"a":1}' } }]);
    assert.equal(choice.finish_reason, "tool_calls");
    assert.deepEqual(completion.usage, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
  });
});

describe("clampPromptCacheKey", () => {
  it("truncates long keys", () => {
    const long = "a".repeat(70);
    assert.equal(clampPromptCacheKey(long).length, 64);
    assert.equal(clampPromptCacheKey("short"), "short");
  });
});

describe("buildResponsesApiPayload", () => {
  it("builds payloads from chat messages", async () => {
    const payload = await buildResponsesApiPayload(
      {
        messages: [{ role: "user", content: "hi" }],
        instructions: "sys",
        temperature: 0.5,
        top_p: 0.9,
        max_tokens: 10,
        tools: [{ type: "function", function: { name: "f", parameters: {} } }],
        tool_choice: { type: "function", function: { name: "f" } },
        parallel_tool_calls: true,
        reasoning_effort: "high",
        previous_response_id: "p",
        prompt_cache_key: "k",
      },
      "m",
      false
    );
    assert.equal(payload.instructions, "sys");
    assert.equal(payload.temperature, 0.5);
    assert.equal(payload.max_output_tokens, 10);
    assert.equal((payload.tools as unknown[]).length, 1);
    assert.deepEqual(payload.tool_choice, { type: "function", name: "f" });
    assert.equal(payload.parallel_tool_calls, true);
    assert.deepEqual(payload.reasoning, { effort: "high" });
    assert.equal(payload.previous_response_id, "p");
    assert.equal(payload.prompt_cache_key, "k");
  });

  it("normalizes supplied responses input and token aliases", async () => {
    const payload = await buildResponsesApiPayload(
      { _responsesInput: [{ role: "user", content: [{ type: "text", text: "hi" }] }], max_output_tokens: 5 },
      "m",
      true
    );
    assert.equal(payload.stream, true);
    assert.equal(payload.max_output_tokens, 5);
    assert.deepEqual((payload.input as Json[])[0]!.content, [{ type: "input_text", text: "hi" }]);
  });

  it("adds reasoning summaries and cache keys", async () => {
    const payload = await buildResponsesApiPayload(
      { messages: [], reasoning: { effort: "low" }, _includeReasoning: true, _sessionId: "s".repeat(70) },
      "m",
      false
    );
    assert.equal((payload.reasoning as Json).summary, "auto");
    assert.deepEqual(payload.include, ["reasoning.encrypted_content"]);
    assert.equal((payload.prompt_cache_key as string).length, 64);
  });
});

describe("response adapters", () => {
  it("converts chat responses for responses clients", async () => {
    const resp = new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200 });
    const adapted = await adaptChatResponseToResponses(resp, "m", false);
    const json = (await adapted.json()) as Json;
    assert.equal(json.object, "response");

    const streamResp = new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n');
    const streamed = await adaptChatResponseToResponses(streamResp, "m", true);
    assert.equal(streamed.headers.get("content-type"), "text/event-stream");
  });

  it("throws without a body", async () => {
    await assert.rejects(adaptChatResponseToResponses(new Response(null), "m", false), /no body/);
  });

  it("skips adaptation when not required", async () => {
    const resp = new Response("ok");
    assert.equal(await adaptForResponsesClient({}, resp, { model: "m" }, false), resp);

    const native = new Response("ok");
    assert.equal(await adaptForResponsesClient({ responsesNative: () => true }, native, { _responsesInput: [], model: "m" }, false), native);

    const converted = await adaptForResponsesClient(
      { responsesNative: () => false },
      new Response(JSON.stringify({ choices: [] })),
      { _responsesInput: [], model: "m" },
      false
    );
    assert.equal((await text(converted)).includes('"object":"response"'), true);
  });
});
