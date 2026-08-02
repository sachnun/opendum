import { describe, expect, it } from "vitest";
import { parseChatCompletions, buildChatCompletions } from "../src/routes/chat.js";
import { parseResponses, buildResponses, convertResponsesInputToMessages } from "../src/routes/responses.js";
import { transformAnthropicToOpenAI, transformOpenAIToAnthropic } from "../src/core/anthropic/transform.js";
import { stripImageContent, stripToolCallParameters } from "../src/core/content.js";
import { kiroSSEToChatSSE, kiroAPIURLForAccount } from "../src/providers/kiro.js";
import { commandCodeTierFromPlanID } from "../src/core/quota/quota-commandcode.js";
import { ProxyService, playgroundSignature } from "../src/service.js";
import { Registry } from "../src/registry/index.js";
import { streamFromString, readAllText } from "../src/providers/http.js";

const registry = Registry.load();

describe("chat completions route (ported from proxy_test.go)", () => {
  it("builds provider payload", () => {
    const messages = [{ role: "user", content: "hello" }];
    const [parsed, routeErr] = parseChatCompletions({
      model: "alias-model",
      messages,
      stream: false,
      temperature: 0.7,
      reasoning_effort: "high",
    });
    expect(routeErr).toBeNull();
    expect(parsed.modelParam).toBe("alias-model");
    expect(parsed.stream).toBe(false);
    expect(parsed.forcedAccountID).toBeNull();
    expect(parsed.reasoningRequested).toBe(true);
    expect(parsed.paramsForError["model"]).toBeUndefined();
    expect(parsed.paramsForError["messages"]).toBeUndefined();
    expect(parsed.paramsForError["stream"]).toBe(false);

    const payload = buildChatCompletions(parsed, "canonical-model", true, "sess_1");
    expect(payload["model"]).toBe("canonical-model");
    expect(payload["messages"]).toEqual(parsed.routeData["messages"]);
    expect(payload["stream"]).toBe(true);
    expect(payload["_includeReasoning"]).toBe(true);
    expect(payload["_sessionId"]).toBe("sess_1");
    expect(payload["temperature"]).toBe(0.7);
    expect(payload["reasoning_effort"]).toBe("high");
  });

  it("validates model and messages", () => {
    const [, missingModel] = parseChatCompletions({ messages: ["hello"] });
    expect(missingModel?.status).toBe(400);
    expect(missingModel?.message).toBe("model is required");
    expect(missingModel?.type).toBe("invalid_request_error");
    const [, missingMessages] = parseChatCompletions({ model: "test-model" });
    expect(missingMessages?.status).toBe(400);
    expect(missingMessages?.message).toBe("messages array is required");
  });

  it("accepts empty messages", () => {
    const [parsed, routeErr] = parseChatCompletions({ model: "test-model", messages: [] });
    expect(routeErr).toBeNull();
    expect(parsed.stream).toBe(false);
    const payload = buildChatCompletions(parsed, "test-model", false, "");
    expect(payload["messages"]).toEqual([]);
  });

  it("reasoning none does not request reasoning", () => {
    const [parsed, routeErr] = parseChatCompletions({ model: "test-model", messages: [], reasoning_effort: "none" });
    expect(routeErr).toBeNull();
    expect(parsed.reasoningRequested).toBe(false);
    const payload = buildChatCompletions(parsed, "test-model", false, "");
    expect(payload["_includeReasoning"]).toBe(false);
  });
});

describe("responses route (ported from proxy_test.go)", () => {
  it("converts input and params", () => {
    const [parsed, routeErr] = parseResponses({
      model: "alias-model",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
      stream: false,
      max_output_tokens: 128,
      instructions: "be brief",
    });
    expect(routeErr).toBeNull();
    expect(parsed.modelParam).toBe("alias-model");
    expect(parsed.paramsForError["max_tokens"]).toBe(128);
    expect(parsed.paramsForError["max_output_tokens"]).toBeUndefined();
    expect(parsed.paramsForError["instructions"]).toBe("be brief");

    const payload = buildResponses(parsed, "canonical-model", true, "sess_2");
    expect(payload["model"]).toBe("canonical-model");
    expect(payload["_responsesInput"]).toEqual(parsed.routeData["responsesInput"]);
    expect(payload["_includeReasoning"]).toBe(parsed.reasoningRequested);
    expect(payload["_sessionId"]).toBe("sess_2");
  });

  it("validates input array", () => {
    const [, routeErr] = parseResponses({ model: "test-model" });
    expect(routeErr?.status).toBe(400);
    expect(routeErr?.message).toBe("input array is required");
  });

  it("converts responses input to messages with function calls", () => {
    const messages = convertResponsesInputToMessages([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "function_call", call_id: "fc_1", name: "tool", arguments: "{}" },
      { type: "function_call_output", call_id: "fc_1", output: "ok" },
    ], "instructions");
    expect(messages[0]).toEqual({ role: "system", content: "instructions" });
    expect(messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "hi" }] });
    expect((messages[2] as Record<string, unknown>)["role"]).toBe("assistant");
    expect(messages[3]).toEqual({ role: "tool", content: "ok", tool_call_id: "call_1" });
  });
});

describe("anthropic transforms (ported from proxy_test.go)", () => {
  it("transforms anthropic to openai", () => {
    const payload = transformAnthropicToOpenAI({
      model: "claude-alias",
      system: [{ type: "text", text: "policy" }],
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "text", text: "hi" }] },
      ],
      max_tokens: 200,
      temperature: 0.5,
    });
    expect(payload["model"]).toBe("claude-alias");
    expect(payload["temperature"]).toBe(0.5);
    expect(payload["max_tokens"]).toBe(200);
    expect(payload["messages"]).toEqual([
      { role: "system", content: "policy" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  it("defaults max_tokens", () => {
    const payload = transformAnthropicToOpenAI({ model: "claude-alias", messages: [] });
    expect(payload["max_tokens"]).toBe(4096);
  });

  it("adaptive thinking maps to reasoning effort", () => {
    const payload = transformAnthropicToOpenAI({
      model: "claude-alias",
      messages: [],
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
    });
    expect(payload["reasoning_effort"]).toBe("medium");
    expect(payload["_includeReasoning"]).toBe(true);
  });

  it("tool choice variants", () => {
    const auto = transformAnthropicToOpenAI({ model: "m", messages: [], tool_choice: { type: "auto" } });
    expect(auto["tool_choice"]).toBe("auto");
    const anyChoice = transformAnthropicToOpenAI({ model: "m", messages: [], tool_choice: { type: "any" } });
    expect(anyChoice["tool_choice"]).toBe("required");
    const tool = transformAnthropicToOpenAI({ model: "m", messages: [], tool_choice: { type: "tool", name: "lookup" } });
    expect(tool["tool_choice"]).toEqual({ type: "function", function: { name: "lookup" } });
  });

  it("converts openai to anthropic with thinking", () => {
    const converted = transformOpenAIToAnthropic({
      choices: [{
        message: { role: "assistant", content: "answer", reasoning_content: "think" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }, "claude-model");
    expect(converted["content"]).toEqual([
      { type: "thinking", thinking: "think" },
      { type: "text", text: "answer" },
    ]);
    expect(converted["stop_reason"]).toBe("end_turn");
  });
});

describe("content stripping (ported from proxy_test.go)", () => {
  it("strips image content", () => {
    const payload: Record<string, unknown> = {
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "x" } }] },
        { role: "user", content: [{ type: "image_url", image_url: { url: "y" } }] },
      ],
    };
    stripImageContent(payload);
    const messages = payload["messages"] as unknown[];
    expect(messages[0]).toEqual({ role: "user", content: "hi" });
    expect(messages[1]).toEqual({ role: "user", content: [] });
  });

  it("strips tool call parameters", () => {
    const payload: Record<string, unknown> = { tools: [], tool_choice: "auto", parallel_tool_calls: true };
    stripToolCallParameters(payload);
    expect(payload["tools"]).toBeUndefined();
    expect(payload["tool_choice"]).toBeUndefined();
    expect(payload["parallel_tool_calls"]).toBeUndefined();
  });
});

describe("kiro SSE reader (ported from kiro_test.go)", () => {
  async function collect(text: string, thinking: boolean): Promise<string> {
    let out = "";
    for await (const chunk of kiroSSEToChatSSE(streamFromString(text), "unit-test-model", thinking)) {
      out += chunk;
    }
    return out;
  }

  it("streams content and usage", async () => {
    const text = await collect(`{"content":"hello"}{"contextUsagePercentage":0.5}{"stop":true}`, false);
    expect(text).toContain("data: [DONE]");
    expect(text).toContain('"content":"hello"');
    expect(text).toContain('"usage"');
  });

  it("extracts reasoning from thinking tags", async () => {
    const text = await collect(`{"content":"<thinking>plan</thinking>\\n\\nanswer"}{"stop":true}`, true);
    expect(text).toContain('"reasoning_content":"plan"');
    expect(text).toContain('"content":"answer"');
  });

  it("extracts reasoning content event", async () => {
    const text = await collect(`{"reasoningContentEvent":{"text":"plan","signature":"sig"}}{"content":"answer"}{"stop":true}`, true);
    expect(text).toContain('"reasoning_content":"plan"');
    expect(text).toContain('"content":"answer"');
  });

  it("preserves utf8 content", async () => {
    const text = await collect(`{"content":"emoji 🙂 text"}{"stop":true}`, true);
    expect(text).not.toContain("\uFFFD");
    // aggregate content across split chunks (splitter emits partial-safe boundaries)
    let content = "";
    for (const chunk of text.split("\n\n")) {
      if (!chunk.startsWith("data: {")) continue;
      const parsed = JSON.parse(chunk.slice(6)) as Record<string, unknown>;
      const choices = (parsed["choices"] ?? []) as unknown[];
      if (choices.length === 0) continue;
      const delta = ((choices[0] as Record<string, unknown>)["delta"] ?? {}) as Record<string, unknown>;
      content += typeof delta["content"] === "string" ? (delta["content"] as string) : "";
    }
    expect(content).toBe("emoji 🙂 text");
  });

  it("api url uses profile arn region", () => {
    const profileArn = "arn:aws:codecatalyst:eu-west-1:123456789012:space/test";
    expect(kiroAPIURLForAccount({ accountId: profileArn } as never)).toBe("https://q.eu-west-1.amazonaws.com/generateAssistantResponse");
  });
});

describe("command code tier (ported from quota_commandcode_test.go)", () => {
  it("maps plan ids to tiers", () => {
    expect(commandCodeTierFromPlanID("individual-go")).toEqual(["go", 10, true]);
    expect(commandCodeTierFromPlanID("individual-max-10x")).toEqual(["max-10x", 150, true]);
    expect(commandCodeTierFromPlanID("individual-max-20x")).toEqual(["max-20x", 300, true]);
    expect(commandCodeTierFromPlanID("team-pro")).toEqual(["team-pro", 40, true]);
    expect(commandCodeTierFromPlanID("unknown-plan")).toEqual(["unknown-plan", 0, false]);
    expect(commandCodeTierFromPlanID("")).toEqual(["", 0, false]);
  });
});

describe("model account selector + playground auth (ported from proxy_test.go)", () => {
  function svc(): ProxyService {
    return new ProxyService(null, null, null as never, null as never, registry, "test-secret");
  }

  it("uses non-provider prefix as account selector", () => {
    const s = svc();
    const [accountID, model, ok] = s.modelAccountSelector("my-account/gpt-5");
    expect(ok).toBe(true);
    expect(accountID).toBe("my-account");
    expect(model).toBe("gpt-5");
  });

  it("preserves provider prefix", () => {
    const s = svc();
    const [, , ok] = s.modelAccountSelector("opencode/gpt-5");
    expect(ok).toBe(false);
  });

  it("accepts signed playground session", () => {
    const s = svc();
    const userId = "user_1";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = playgroundSignature("test-secret", userId, timestamp, "POST", "/v1/chat/completions");
    const request = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "X-Opendum-Playground-User-Id": userId,
        "X-Opendum-Playground-Timestamp": timestamp,
        "X-Opendum-Playground-Signature": signature,
      },
    });
    const result = s.validatePlaygroundAuth(request);
    expect(result?.valid).toBe(true);
    expect(result?.userId).toBe(userId);
  });

  it("rejects invalid signature", () => {
    const s = svc();
    const request = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "X-Opendum-Playground-User-Id": "user_1",
        "X-Opendum-Playground-Timestamp": String(Math.floor(Date.now() / 1000)),
        "X-Opendum-Playground-Signature": "deadbeef",
      },
    });
    const result = s.validatePlaygroundAuth(request);
    expect(result?.valid).toBe(false);
  });

  it("ignores missing playground headers", () => {
    const s = svc();
    const request = new Request("http://localhost/v1/chat/completions", { method: "POST" });
    expect(s.validatePlaygroundAuth(request)).toBeNull();
  });

  it("rejects expired timestamp", () => {
    const s = svc();
    const userId = "user_1";
    const timestamp = String(Math.floor(Date.now() / 1000) - 3 * 60);
    const signature = playgroundSignature("test-secret", userId, timestamp, "POST", "/v1/chat/completions");
    const request = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "X-Opendum-Playground-User-Id": userId,
        "X-Opendum-Playground-Timestamp": timestamp,
        "X-Opendum-Playground-Signature": signature,
      },
    });
    const result = s.validatePlaygroundAuth(request);
    expect(result?.valid).toBe(false);
  });
});
