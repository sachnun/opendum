import { describe, expect, it } from "vitest";
import { encrypt, decrypt, hashString } from "../src/crypto/index.js";
import { Registry, normalizeProviderAlias } from "../src/registry/index.js";
import { parseModelParam, normalizeTierAlias, tierSatisfiesRule } from "../src/auth/models.js";
import { isPaidAccountTier, effectiveUnhealthyCount, modelHealthStatus, cooldownRecoveryCount, failedCooldownUntil, accountAccessDenial, normalizeAccountListHelper } from "./lb-helpers.js";
import { bearerToken, normalizeAccessMode } from "../src/auth/service.js";
import { extractProviderErrorDetail, sanitizedProxyError, buildAccountErrorMessage, shouldRotate, normalizeClientError } from "../src/core/errors.js";
import { normalizeCallID, convertResponsesInputToMessages, responsesToolsToChat } from "../src/routes/responses.js";
import { toResponsesAPIID, toChatCallID } from "../src/providers/responses_transform.js";
import { playgroundSignature } from "../src/service.js";
import { validateInternalSignature } from "../src/errors.js";
import { qoderEncodeBody, splitQoderAccountID, qoderExtractBody } from "../src/providers/qoder.js";
import { transformAnthropicToOpenAI, transformOpenAIToAnthropic } from "../src/core/anthropic/transform.js";
import { parseKiroJSONEvents, newKiroParserState, convertKiroEventsToCompletion, KiroThinkingSplitter, kiroUsageFromContext, parseKiroBracketToolCalls } from "../src/providers/kiro.js";
import { messagesToResponsesInput, normalizeResponsesInput, responseUsageToChatUsage, responsesJSONToChatCompletion, chatCompletionToResponsesJSON } from "../src/providers/responses_transform.js";
import { retryMetadata, isAntigravityResourceExhausted, codexUsageLimitDisabledUntil } from "../src/core/errors.js";

describe("crypto", () => {
  it("roundtrips encrypt/decrypt (CryptoJS-compatible format)", () => {
    const cipher = encrypt("secret-passphrase", "hello world");
    expect(cipher.startsWith("Salted__")).toBe(false); // base64-encoded
    expect(Buffer.from(cipher, "base64").subarray(0, 8).toString()).toBe("Salted__");
    expect(decrypt("secret-passphrase", cipher)).toBe("hello world");
  });

  it("hashString is sha256 hex", () => {
    expect(hashString("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("registry", () => {
  it("resolves aliases and supports models", () => {
    const registry = Registry.load();
    const all = registry.allModels();
    expect(all.length).toBeGreaterThan(50);
    // every canonical model resolves to itself
    for (const model of all.slice(0, 20)) {
      expect(registry.resolveAlias(model)).toBe(model);
    }
  });

  it("normalizeProviderAlias lowercases and trims", () => {
    expect(normalizeProviderAlias("  Codex ")).toBe("codex");
  });
});

describe("auth models", () => {
  it("parseModelParam splits provider/model", () => {
    expect(parseModelParam("codex/gpt-5")).toEqual({ provider: "codex", rawModel: "gpt-5" });
    expect(parseModelParam("gpt-5")).toEqual({ provider: null, rawModel: "gpt-5" });
  });

  it("normalizeTierAlias maps aliases", () => {
    expect(normalizeTierAlias("pro_plus")).toBe("pro+");
    expect(normalizeTierAlias("free-tier")).toBe("free");
    expect(normalizeTierAlias("education")).toBe("student");
    expect(normalizeTierAlias("Pro")).toBe("pro");
  });

  it("tierSatisfiesRule", () => {
    expect(tierSatisfiesRule("pro", "pro", [])).toBe(true);
    expect(tierSatisfiesRule("free", "pro", [])).toBe(false);
    expect(tierSatisfiesRule("pro+", "", ["pro+"])).toBe(true);
    expect(tierSatisfiesRule("free", "", ["pro"])).toBe(false);
  });
});

describe("auth service helpers", () => {
  it("bearerToken parses Bearer prefix", () => {
    expect(bearerToken("Bearer sk-123")).toBe("sk-123");
    expect(bearerToken("  Bearer  sk-123  ")).toBe("sk-123");
    expect(bearerToken("sk-123")).toBe("sk-123");
  });

  it("normalizeAccessMode", () => {
    expect(normalizeAccessMode("whitelist")).toBe("whitelist");
    expect(normalizeAccessMode("blacklist")).toBe("blacklist");
    expect(normalizeAccessMode("anything")).toBe("all");
  });
});

describe("load balancer helpers", () => {
  it("isPaidAccountTier", () => {
    expect(isPaidAccountTier("kiro", "pro")).toBe(true);
    expect(isPaidAccountTier("kiro", "pro-plus")).toBe(true);
    expect(isPaidAccountTier("antigravity", "standard-tier")).toBe(true);
    expect(isPaidAccountTier("antigravity", "free-tier")).toBe(false);
    expect(isPaidAccountTier("codex", "free")).toBe(false);
    expect(isPaidAccountTier("codex", "plus")).toBe(true);
  });

  it("effectiveUnhealthyCount decays over idle intervals", () => {
    const row = {
      consecutiveErrors: 5,
      unhealthyCountUpdatedAt: new Date(Date.now() - 30 * 60 * 1000),
      lastErrorAt: new Date(Date.now() - 30 * 60 * 1000),
      lastSuccessAt: null,
      updatedAt: new Date(),
      createdAt: new Date(),
    } as never;
    expect(effectiveUnhealthyCount(row, new Date())).toBe(2); // 5 - floor(30/10)=3
  });

  it("modelHealthStatus threshold", () => {
    expect(modelHealthStatus(0)).toBe("active");
    expect(modelHealthStatus(1)).toBe("active");
    expect(modelHealthStatus(2)).toBe("degraded");
  });

  it("cooldownRecoveryCount applies 30% reduction", () => {
    expect(cooldownRecoveryCount(10)).toBe(7); // 10 - round(3)
    expect(cooldownRecoveryCount(0)).toBe(0);
  });

  it("failedCooldownUntil is 10 minutes", () => {
    const at = new Date(0);
    expect(failedCooldownUntil(at).getTime()).toBe(10 * 60 * 1000);
  });

  it("accountAccessDenial whitelist/blacklist", () => {
    const [, , denied] = accountAccessDenial("acc-1", { mode: "whitelist", accounts: ["acc-2"] });
    expect(denied).toBe(true);
    const [, , allowed] = accountAccessDenial("acc-1", { mode: "whitelist", accounts: ["acc-1"] });
    expect(allowed).toBe(false);
    const [msg, code, blocked] = accountAccessDenial("acc-1", { mode: "blacklist", accounts: ["acc-1"] });
    expect(blocked).toBe(true);
    expect(code).toBe("provider_account_blacklisted");
    expect(msg).toContain("blocked");
  });

  it("normalizeAccountList dedupes and sorts", () => {
    expect(normalizeAccountListHelper(["b", "a", "b", " "])).toEqual(["a", "b"]);
  });
});

describe("errors sanitization", () => {
  it("extracts provider error detail from JSON", () => {
    expect(extractProviderErrorDetail('{"error":{"message":"Bad thing"}}')).toBe("Bad thing");
    expect(extractProviderErrorDetail('{"message":"Top"}\n')).toBe("Top");
    expect(extractProviderErrorDetail("plain text here")).toBe("plain text here");
  });

  it("sanitizedProxyError maps types by status", () => {
    expect(sanitizedProxyError(429, "{}")[1]).toBe("rate_limit_error");
    expect(sanitizedProxyError(401, "")[1]).toBe("authentication_error");
    expect(sanitizedProxyError(500, "")[1]).toBe("api_error");
    expect(sanitizedProxyError(400, "")[1]).toBe("invalid_request_error");
    expect(sanitizedProxyError(408, "")[1]).toBe("timeout_error");
  });

  it("normalizeClientError truncates and collapses whitespace", () => {
    expect(normalizeClientError("  a\n\n b  ")).toBe("a b");
    expect(normalizeClientError("x".repeat(500)).length).toBeLessThanOrEqual(320 + 14);
  });

  it("buildAccountErrorMessage redacts messages", () => {
    const msg = buildAccountErrorMessage("boom", { model: "gpt-5", provider: "codex", endpoint: "/v1/chat/completions", messages: [{ role: "user", content: "secret" }], parameters: { temperature: 0.7, messages: [{ role: "user", content: "secret" }] } });
    expect(msg).toContain("Error: boom");
    expect(msg).toContain("Provider: codex");
    expect(msg).toContain("Model: gpt-5");
    expect(msg).toContain('"messages": "[redacted');
  });

  it("shouldRotate", () => {
    expect(shouldRotate(500)).toBe(true);
    expect(shouldRotate(429)).toBe(true);
    expect(shouldRotate(404)).toBe(true);
    expect(shouldRotate(400)).toBe(false);
  });

  it("retryMetadata", () => {
    expect(retryMetadata(1500)).toEqual(["2s", 1500]);
    expect(retryMetadata(0)).toEqual([null, null]);
  });

  it("isAntigravityResourceExhausted", () => {
    expect(isAntigravityResourceExhausted("antigravity", 429, '{"error":{"status":"RESOURCE_EXHAUSTED"}}')).toBe(true);
    expect(isAntigravityResourceExhausted("antigravity", 429, '{"error":{"status":"OTHER"}}')).toBe(false);
    expect(isAntigravityResourceExhausted("codex", 429, '{"error":{"status":"RESOURCE_EXHAUSTED"}}')).toBe(false);
  });

  it("codexUsageLimitDisabledUntil", () => {
    const now = new Date();
    const [until, ok] = codexUsageLimitDisabledUntil("codex", 429, '{"error":{"type":"usage_limit_reached","resets_in_seconds":3600}}', now);
    expect(ok).toBe(true);
    expect(until.getTime()).toBe(now.getTime() + 3600 * 1000);
  });
});

describe("routes helpers", () => {
  it("normalizeCallID", () => {
    expect(normalizeCallID("fc_123")).toBe("call_123");
    expect(normalizeCallID("call_123")).toBe("call_123");
  });

  it("toResponsesAPIID / toChatCallID roundtrip", () => {
    expect(toResponsesAPIID("call_123")).toBe("fc_123");
    expect(toChatCallID("fc_123")).toBe("call_123");
  });

  it("convertResponsesInputToMessages", () => {
    const messages = convertResponsesInputToMessages(
      [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "function_call", call_id: "fc_1", name: "tool", arguments: "{}" },
        { type: "function_call_output", call_id: "fc_1", output: "ok" },
      ],
      "be nice",
    );
    expect(messages[0]).toEqual({ role: "system", content: "be nice" });
    expect((messages[1] as Record<string, unknown>)["role"]).toBe("user");
    expect((messages[2] as Record<string, unknown>)["role"]).toBe("assistant");
    expect(messages[3]).toEqual({ role: "tool", content: "ok", tool_call_id: "call_1" });
  });

  it("responsesToolsToChat flattens namespaces", () => {
    const tools = responsesToolsToChat([{ type: "namespace", name: "fs_", tools: [{ type: "function", name: "read", parameters: {} }] }]);
    expect(tools).toEqual([{ type: "function", function: { name: "fs_read", parameters: {} } }]);
  });
});

describe("signatures", () => {
  it("playgroundSignature is hmac-sha256 hex", () => {
    const sig = playgroundSignature("secret", "user1", "1234", "POST", "/v1/chat/completions");
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    // deterministic
    expect(playgroundSignature("secret", "user1", "1234", "POST", "/v1/chat/completions")).toBe(sig);
  });

  it("validateInternalSignature", () => {
    const secret = "test-secret";
    const body = new TextEncoder().encode("{}");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const { createHmac } = require("node:crypto") as typeof import("node:crypto");
    const mac = createHmac("sha256", secret);
    mac.update(timestamp).update("\n").update("/internal/quota").update("\n").update(body);
    const sig = mac.digest("hex");
    const request = new Request("http://localhost/internal/quota", {
      method: "POST",
      headers: { "X-Opendum-Internal-Timestamp": timestamp, "X-Opendum-Internal-Signature": sig },
      body: "{}",
    });
    expect(validateInternalSignature(secret, request, "/internal/quota", body)).toBe(true);
    expect(validateInternalSignature(secret, request, "/internal/refresh", body)).toBe(false);
    expect(validateInternalSignature("wrong", request, "/internal/quota", body)).toBe(false);
  });
});

describe("qoder", () => {
  it("qoderEncodeBody substitutes alphabet and rotates thirds", () => {
    const encoded = qoderEncodeBody("hello");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    // decode back
    const stdAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const custom = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
    const table = new Map<string, string>();
    for (let i = 0; i < stdAlphabet.length; i++) table.set(custom[i]!, stdAlphabet[i]!);
    let reversed = "";
    for (const ch of encoded) reversed += ch === "$" ? "=" : (table.get(ch) ?? ch);
    const n = reversed.length;
    const a = Math.floor(n / 3);
    const restored = reversed.slice(n - a) + reversed.slice(a, n - a) + reversed.slice(0, a);
    expect(Buffer.from(restored, "base64").toString("utf8")).toBe("hello");
  });

  it("splitQoderAccountID", () => {
    expect(splitQoderAccountID("uid|machine")).toEqual(["uid", "machine"]);
    expect(splitQoderAccountID("only")).toEqual(["only", "only"]);
    expect(splitQoderAccountID(null)).toEqual(["", ""]);
  });

  it("qoderExtractBody unwraps envelope", () => {
    expect(qoderExtractBody('{"body":"{\\"a\\":1}","statusCode":"OK"}')).toBe('{"a":1}');
    expect(qoderExtractBody("plain")).toBe("plain");
  });
});

describe("anthropic transforms", () => {
  it("transformAnthropicToOpenAI moves system out and sets max_tokens", () => {
    const payload = transformAnthropicToOpenAI({
      model: "claude-3-7",
      system: [{ type: "text", text: "sys" }],
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
      thinking: { type: "enabled", budget_tokens: 5000 },
    });
    expect(payload["messages"]).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
    expect(payload["max_tokens"]).toBe(100);
    expect(payload["thinking_budget"]).toBe(5000);
    expect(payload["_includeReasoning"]).toBe(true);
    expect(payload["system"]).toBeUndefined();
  });

  it("transformOpenAIToAnthropic maps reasoning to thinking blocks", () => {
    const converted = transformOpenAIToAnthropic(
      { choices: [{ message: { content: "answer", reasoning_content: "think" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      "claude-3-7",
    );
    expect(converted["type"]).toBe("message");
    expect(converted["content"]).toEqual([
      { type: "thinking", thinking: "think" },
      { type: "text", text: "answer" },
    ]);
    expect(converted["usage"]).toEqual({ input_tokens: 10, output_tokens: 5 });
  });
});

describe("responses transforms", () => {
  it("messagesToResponsesInput maps roles", () => {
    const input = messagesToResponsesInput([
      { role: "system", content: "s" },
      { role: "user", content: "u" },
      { role: "assistant", content: "a", tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "out" },
    ]);
    expect(input[0]).toEqual({ type: "message", role: "developer", content: "s" });
    expect(input[1]).toEqual({ type: "message", role: "user", content: "u" });
    // assistant with non-empty content AND tool calls emits message then function_call
    expect(input[2]).toEqual({ type: "message", role: "assistant", content: "a" });
    expect(input[3]).toEqual({ type: "function_call", id: "fc_1", call_id: "fc_1", name: "f", arguments: "{}" });
    expect(input[4]).toEqual({ type: "function_call_output", call_id: "fc_1", output: "out" });
  });

  it("responseUsageToChatUsage", () => {
    expect(responseUsageToChatUsage({ input_tokens: 3, output_tokens: 4 })).toEqual({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
  });

  it("responsesJSONToChatCompletion", () => {
    const completion = responsesJSONToChatCompletion(
      { output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }], status: "completed", usage: { input_tokens: 1, output_tokens: 2 } },
      "gpt-5",
    );
    expect(completion["choices"]).toEqual([{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }]);
  });

  it("chatCompletionToResponsesJSON", () => {
    const response = chatCompletionToResponsesJSON(
      { choices: [{ message: { content: "hi", reasoning_content: "r" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2 } },
      "gpt-5",
    );
    expect(response["object"]).toBe("response");
    expect(response["status"]).toBe("completed");
    expect(response["output"]).toEqual([
      { type: "reasoning", text: "r" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
    ]);
  });
});

describe("kiro", () => {
  it("parseKiroJSONEvents extracts nested events", () => {
    const state = newKiroParserState();
    const events = parseKiroJSONEvents('{"assistantResponseEvent":{"content":"hi","type":"assistantResponseEvent"},"toolUseEvent":{"name":"f","toolUseId":"t1","input":"{}","type":"toolUseEvent"}} {\"stop\":true}', state);
    expect(events.length).toBe(3);
    expect(events[0]!["content"]).toBe("hi");
    expect(events[1]!["name"]).toBe("f");
    expect(events[2]!["stop"]).toBe(true);
  });

  it("converts events to completion with tool calls", () => {
    const events = [
      { content: "hello", followupPrompt: undefined },
      { name: "tool", toolUseId: "t1", input: "{}" },
      { stop: true },
    ];
    const completion = convertKiroEventsToCompletion(events, "kiro-model", false);
    expect(completion["choices"]).toEqual([
      { index: 0, message: { role: "assistant", content: "hello", tool_calls: [{ id: "t1", type: "function", function: { name: "tool", arguments: "{}" } }] }, finish_reason: "tool_calls" },
    ]);
  });

  it("kiroUsageFromContext estimates tokens", () => {
    const usage = kiroUsageFromContext("kiro-model", 50, "x".repeat(100));
    expect(usage["completion_tokens"]).toBe(25);
    expect(usage["prompt_tokens"]).toBe(100000 - 25);
  });

  it("kiro thinking splitter extracts thinking tags", () => {
    const splitter = new KiroThinkingSplitter(true);
    const [content, reasoning] = splitter.process("before <thinking>secret</thinking> after", true);
    expect(content).toBe("before  after"); // matches Go: tag boundaries leave surrounding spaces
    expect(reasoning).toBe("secret");
  });

  it("parseKiroBracketToolCalls", () => {
    const calls = parseKiroBracketToolCalls('text [Called my_tool with args: {"a":1}] more');
    expect(calls.length).toBe(1);
    expect(calls[0]!.Name).toBe("my_tool");
    expect(calls[0]!.Arguments).toBe('{"a":1}');
  });
});
