import { describe, expect, it } from "vitest";
import { Registry } from "../src/registry/index.js";
import { AuthModelService } from "../src/auth/models.js";
import { parseMessages, buildMessages } from "../src/routes/messages.js";
import { providerDisplayName, prefixWithProvider, buildAccountErrorMessage } from "../src/core/errors.js";
import { accountErrorTextLimit } from "../src/core/errors.js";

function registry(): Registry {
  return Registry.load();
}

describe("auth models (ported from models_test.go)", () => {
  it("rejects codex chatgpt incompatible model", () => {
    const svc = new AuthModelService(null, null, registry());
    const result = svc.validateModel("codex/gpt-5.1-codex");
    expect(result.valid).toBe(false);
    expect(result.code).toBe("unsupported_codex_chatgpt_model");
    expect(result.param).toBe("model");
    expect(result.error).toContain("not supported for Codex when using a ChatGPT account");
    expect(result.error).toContain("gpt-5.5");
  });

  it("accepts codex chatgpt compatible model", () => {
    const svc = new AuthModelService(null, null, registry());
    const result = svc.validateModel("codex/gpt-5.5");
    expect(result.valid).toBe(true);
    expect(result.provider).toBe("codex");
    expect(result.model).toBe("gpt-5.5");
  });

  it("suggests similar models", () => {
    const svc = new AuthModelService(null, null, registry());
    const result = svc.validateModel("gemini-2.5-flas");
    expect(result.valid).toBe(false);
    expect(result.code).toBe("invalid_model");
    expect(result.error).toContain("Did you mean:");
    expect(result.error).toContain("gemini-2.5-flash");
  });

  it("suggests from token typos", () => {
    const svc = new AuthModelService(null, null, registry());
    const result = svc.validateModel("clod opua 46");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Did you mean:");
    expect(result.error).toContain("claude-opus-4-6");
  });

  it("validateModelForUser hides api key model access denials", async () => {
    const svc = new AuthModelService(null, null, registry());
    // whitelist denies gemini-2.5-flash; suggestion list must not leak the denied model
    const result = await svc.validateModelForUser("user_1", "gemini-2.5-flas", {
      mode: "whitelist",
      models: ["gemini-2.5-flash-lite"],
      roamingEnabled: false,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Did you mean:");
    expect(result.error).toContain("gemini-2.5-flash-lite");
    expect(result.error).not.toContain("Did you mean: gemini-2.5-flash ?");
  });
});

describe("messages route (ported from routes_messages_test.go)", () => {
  it("builds provider payload from anthropic messages", () => {
    const [parsed, routeErr] = parseMessages({
      model: "claude-alias",
      system: "follow policy",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
      max_tokens: 200,
      thinking: { type: "enabled", budget_tokens: 1024 },
    });
    expect(routeErr).toBeNull();
    expect(parsed.modelParam).toBe("claude-alias");
    expect(parsed.stream).toBe(false);
    expect(parsed.forcedAccountID).toBeNull();
    expect(parsed.messagesForError).toEqual([{ role: "user", content: "hello" }]);
    expect(parsed.paramsForError["model"]).toBeUndefined();
    expect(parsed.paramsForError["messages"]).toBeUndefined();
    expect(parsed.paramsForError["stream"]).toBe(false);

    const payload = buildMessages(parsed, "claude-canonical", true, "sess_3");
    expect(payload["model"]).toBe("claude-canonical");
    expect(payload["stream"]).toBe(true);
    expect(payload["_sessionId"]).toBe("sess_3");
    expect(payload["_includeReasoning"]).toBe(true);
    expect(payload["thinking_budget"]).toBe(1024);
    expect(payload["system"]).toBeUndefined();
    const messages = payload["messages"] as unknown[];
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "system", content: "follow policy" });
    expect(messages[1]).toEqual({ role: "user", content: "hello" });
  });

  it("defaults stream false and validates model", () => {
    const [parsed, routeErr] = parseMessages({ model: "claude-alias", messages: [] });
    expect(routeErr).toBeNull();
    expect(parsed.stream).toBe(false);

    const [, missingModelErr] = parseMessages({ messages: [] });
    expect(missingModelErr?.status).toBe(400);
    expect(missingModelErr?.message).toBe("model is required");
    expect(missingModelErr?.type).toBe("invalid_request_error");
  });
});

describe("errors sanitization (ported from errors_sanitization_test.go)", () => {
  it("providerDisplayName", () => {
    const cases: Array<[string, string]> = [
      ["antigravity", "Antigravity"],
      ["codex", "Codex"],
      ["command_code", "Command Code"],
      ["kiro", "Kiro"],
      ["nvidia_nim", "Nvidia"],
      ["openrouter", "OpenRouter"],
      ["workers_ai", "Cloudflare"],
      ["qoder", "Qoder"],
      ["zenmux", "ZenMux"],
      ["siliconflow", "SiliconFlow"],
      ["opencode", "Opencode"],
      ["kilo_code", "Kilo Code"],
      ["mimo_code", "MiMo Code"],
      ["", ""],
      ["unknown_provider", "unknown_provider"],
    ];
    for (const [provider, want] of cases) {
      expect(providerDisplayName(provider)).toBe(want);
    }
  });

  it("prefixWithProvider", () => {
    expect(prefixWithProvider("siliconflow", "Sorry, your account balance is insufficient.")).toBe("[SiliconFlow] Sorry, your account balance is insufficient.");
    expect(prefixWithProvider("workers_ai", "rate limit exceeded")).toBe("[Cloudflare] rate limit exceeded");
    expect(prefixWithProvider("made_up", "boom")).toBe("[made_up] boom");
    expect(prefixWithProvider("", "boom")).toBe("boom");
    expect(prefixWithProvider("siliconflow", "")).toBe("");
  });

  it("sanitizeParametersForError redacts and summarizes", () => {
    const params: Record<string, unknown> = {
      messages: [{ role: "user", content: "secret" }],
      tools: [
        { function: { name: "lookup" } },
        { name: "search" },
      ],
      prompt: "a".repeat(accountErrorTextLimit + 1),
      metadata: { nested: "b".repeat(accountErrorTextLimit + 1) },
    };
    const message = buildAccountErrorMessage("boom", { model: "m", provider: "p", endpoint: "/v1/chat/completions", messages: params["messages"], parameters: params });
    expect(message).toContain('[redacted: see \\"Messages (object keys only)\\"]');
    expect(message).toContain("[2 tool(s): lookup, search]");
    expect(message).toContain("...[truncated, 201 chars total]");
  });
});

describe("registry capability defaults (ported from registry_test.go)", () => {
  it("defaults to supported for missing metadata", () => {
    const reg = registry();
    // unknown models are unsupported
    expect(reg.isVisionModel("definitely-not-a-model")).toBe(false);
    expect(reg.isReasoningModel("definitely-not-a-model")).toBe(false);
    expect(reg.isToolCallModel("definitely-not-a-model")).toBe(false);
    // models without meta default capabilities to true
    const noMeta = reg.allModels().find((m) => reg.modelInfo(m)?.meta === null || reg.modelInfo(m)?.meta === undefined);
    if (noMeta) {
      expect(reg.isVisionModel(noMeta)).toBe(true);
      expect(reg.isReasoningModel(noMeta)).toBe(true);
      expect(reg.isToolCallModel(noMeta)).toBe(true);
    }
  });
});
