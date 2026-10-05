import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  chatCompletionsConfig,
  messagesConfig,
  parseRequiredModel,
  parseStreamParam,
  responsesConfig,
} from "../src/core/transport/endpoints.ts";
import type { ParsedEndpointRequest, RouteError } from "../src/core/types.ts";

type Json = Record<string, unknown>;

function isError(value: unknown): value is RouteError {
  return typeof value === "object" && value !== null && "status" in value;
}

describe("parse helpers", () => {
  it("requires a model", () => {
    assert.equal(isError(parseRequiredModel({})), true);
    assert.deepEqual(parseRequiredModel({ model: "  m  " }), { model: "m" });
  });

  it("reads the stream flag", () => {
    assert.equal(parseStreamParam({ stream: true }), true);
    assert.equal(parseStreamParam({ stream: "yes" }), false);
  });
});

describe("chatCompletionsConfig", () => {
  it("validates requests", () => {
    const cfg = chatCompletionsConfig();
    assert.equal(isError(cfg.parse({})), true);
    assert.equal(isError(cfg.parse({ model: "m" })), true);
    assert.equal(isError(cfg.parse({ model: "m", messages: [] })), false);
  });

  it("parses and builds chat payloads", () => {
    const cfg = chatCompletionsConfig();
    const parsed = cfg.parse({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      temperature: 0.5,
      reasoning_effort: "high",
    }) as ParsedEndpointRequest;
    assert.equal(parsed.modelParam, "m");
    assert.equal(parsed.stream, true);
    assert.equal(parsed.reasoningRequested, true);
    assert.deepEqual(parsed.paramsForError, { temperature: 0.5, reasoning_effort: "high", stream: true });

    const payload = cfg.build(parsed, "upstream", false, "sess");
    assert.equal(payload.model, "upstream");
    assert.equal(payload.stream, false);
    assert.equal(payload._includeReasoning, true);
    assert.equal(payload._sessionId, "sess");
    assert.deepEqual(payload.messages, [{ role: "user", content: "hi" }]);
  });

  it("detects disabled reasoning", () => {
    const cfg = chatCompletionsConfig();
    const disabled = cfg.parse({ model: "m", messages: [], include_thoughts: false }) as ParsedEndpointRequest;
    assert.equal(disabled.reasoningRequested, false);
    const none = cfg.parse({ model: "m", messages: [], reasoning: { effort: "none" } }) as ParsedEndpointRequest;
    assert.equal(none.reasoningRequested, false);
    const budget = cfg.parse({ model: "m", messages: [], thinking_budget: 100 }) as ParsedEndpointRequest;
    assert.equal(budget.reasoningRequested, true);
  });
});

describe("messagesConfig", () => {
  it("parses and builds anthropic payloads", () => {
    const cfg = messagesConfig();
    const parsed = cfg.parse({ model: "m", messages: [], stream: false, system: "sys" }) as ParsedEndpointRequest;
    assert.equal(parsed.stream, false);
    const payload = cfg.build(parsed, "upstream", false, "sess");
    assert.equal(payload.model, "upstream");
    assert.equal(payload.stream, false);
    assert.equal(payload._sessionId, "sess");
    assert.deepEqual(payload.messages, [{ role: "system", content: "sys" }]);
  });
});

describe("responsesConfig", () => {
  it("requires an input array", () => {
    const cfg = responsesConfig();
    assert.equal(isError(cfg.parse({ model: "m" })), true);
  });

  it("converts responses input into chat messages", () => {
    const cfg = responsesConfig();
    const parsed = cfg.parse({
      model: "m",
      instructions: "sys",
      stream: true,
      max_output_tokens: 5,
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "hi" }] },
        { type: "reasoning", summary: [{ text: "why" }] },
        { type: "function_call", call_id: "fc_1", name: "f", arguments: '{"a":1}' },
        { type: "function_call_output", call_id: "fc_1", output: [{ text: "ok" }] },
      ],
    }) as ParsedEndpointRequest;
    assert.equal(parsed.stream, true);
    assert.deepEqual(parsed.paramsForError, { max_tokens: 5, stream: true, instructions: "sys" });
    const messages = parsed.routeData.messages as Json[];
    assert.equal(messages[0]!.role, "system");
    assert.equal(messages[1]!.role, "system");
    assert.deepEqual(messages[2], { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: '{"a":1}' } }], reasoning_content: "why" });
    assert.deepEqual(messages[3], { role: "tool", content: "ok", tool_call_id: "call_1" });
  });

  it("builds responses payloads with tools", () => {
    const cfg = responsesConfig();
    const parsed = cfg.parse({
      model: "m",
      input: [],
      tools: [
        { type: "namespace", name: "ns", tools: [{ type: "function", name: "a", parameters: {} }] },
        { type: "function", name: "b", parameters: {} },
      ],
    }) as ParsedEndpointRequest;
    const payload = cfg.build(parsed, "upstream", true, "sess");
    assert.equal(payload.model, "upstream");
    assert.equal(payload.stream, true);
    assert.equal(payload._includeReasoning, false);
    assert.deepEqual(payload.tools, [
      { type: "function", function: { name: "nsa", parameters: {} } },
      { type: "function", function: { name: "b", parameters: {} } },
    ]);
    assert.equal(payload._sessionId, "sess");
  });

  it("infers input item types", () => {
    const cfg = responsesConfig();
    const parsed = cfg.parse({
      model: "m",
      input: [
        { summary: "s" },
        { encrypted_content: "e" },
        { call_id: "c", name: "f" },
        { call_id: "c", output: "o" },
        { role: "user", content: "hi" },
      ],
    }) as ParsedEndpointRequest;
    const messages = parsed.routeData.messages as Json[];
    assert.equal(messages.length, 3);
    assert.equal(messages.at(-1)!.role, "user");
  });

  it("handles reasoning and content variants", () => {
    const cfg = responsesConfig();
    const parsed = cfg.parse({
      model: "m",
      input: [
        { type: "reasoning", content: [{ text: "a" }, { text: "b" }] },
        { type: "reasoning", text: "plain" },
        { type: "message", content: [{ type: "input_text", text: "hi" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "yo" }] },
      ],
    }) as ParsedEndpointRequest;
    const messages = parsed.routeData.messages as Json[];
    assert.equal((messages.at(-2) as Json).reasoning_content, undefined);
    assert.deepEqual((messages.at(-1) as Json).content, [{ type: "text", text: "yo" }]);
  });

  it("converts images and namespaced tools", () => {
    const cfg = responsesConfig();
    const parsed = cfg.parse({
      model: "m",
      input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://x/y.png" }] }],
      tools: [{ type: "function", function: { name: "f", parameters: {} } }],
    }) as ParsedEndpointRequest;
    const payload = cfg.build(parsed, "up", false, "s");
    const message = (payload.messages as Json[])[0]!;
    assert.deepEqual(message.content, [{ type: "image_url", image_url: { url: "https://x/y.png" } }]);
    assert.deepEqual(payload.tools, [{ type: "function", function: { name: "f", parameters: {} } }]);
  });

  it("drops unknown responses input items", () => {
    const cfg = responsesConfig();
    const parsed = cfg.parse({ model: "m", input: [{ type: "unknown" }] }) as ParsedEndpointRequest;
    assert.deepEqual(parsed.routeData.messages, []);
  });

  it("covers reasoning toggles and missing models", () => {
    const chat = chatCompletionsConfig();
    assert.equal((chat.parse({}) as RouteError).status, 400);
    assert.equal((chat.parse({ model: "m", messages: [], include_thoughts: true }) as ParsedEndpointRequest).reasoningRequested, true);
    assert.equal((chat.parse({ model: "m", messages: [], reasoning: { effort: "low" } }) as ParsedEndpointRequest).reasoningRequested, true);
    assert.equal((chat.parse({ model: "m", messages: [], reasoning: { include_thoughts: false } }) as ParsedEndpointRequest).reasoningRequested, false);
    assert.equal((responsesConfig().parse({}) as RouteError).status, 400);
  });

  it("handles unknown content, instructions and empty items", () => {
    const cfg = responsesConfig();
    const parsed = cfg.parse({
      model: "m",
      instructions: "sys",
      input: [
        { type: "message", role: "user", content: [{ type: "unknown", value: 1 }] },
        {},
        { type: "reasoning", summary: ["s", 5] },
        { type: "function_call_output", call_id: "c1", output: 5 },
      ],
    }) as ParsedEndpointRequest;
    const payload = cfg.build(parsed, "up", false, "s");
    assert.equal(payload.instructions, "sys");
    const messages = payload.messages as Json[];
    assert.equal(messages[0]!.role, "system");
    assert.deepEqual(messages[1]!.content, [{ type: "unknown", value: 1 }]);
    assert.equal(messages[2]!.role, "tool");
    assert.equal(messages[2]!.content, "");
    assert.equal(messages[2]!.tool_call_id, "c1");
  });
});
