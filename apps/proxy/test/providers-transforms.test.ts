import { describe, expect, it } from "vitest";
import { KiroProvider } from "../src/providers/kiro.js";
import { CodexProvider, extractAccountIDFromJWT, extractTierFromJWT } from "../src/providers/codex.js";
import { OpencodeProvider, OpenAICompatibleProvider } from "../src/providers/providers.js";
import { WorkersAIProvider } from "../src/providers/providers.js";
import { Registry } from "../src/registry/index.js";
import { openAIToGemini, geminiToOpenAICompletion, scrubToolTranscriptArtifacts, injectGeminiToolInstruction, GoogleCodeAssistProvider, antigravityDelegateConfig, type ToolSchemaMap } from "../src/providers/google_code_assist.js";
import { isSafeExternalURL } from "../src/providers/images.js";
import type { HttpClient, ProviderAccountLike, UpstreamResponse } from "../src/providers/types.js";
import { streamFromString } from "../src/providers/http.js";

class CaptureClient implements HttpClient {
  requests: Array<{ url: string; method: string; headers: Record<string, string>; body: string | undefined }> = [];
  response: UpstreamResponse = { status: 200, headers: { "content-type": "application/json" }, body: streamFromString(`{"choices":[{"message":{"content":"ok"}}]}`) };
  private handler?: (req: { url: string; headers: Record<string, string>; body: string }) => UpstreamResponse | undefined;

  onRequest(handler: (req: { url: string; headers: Record<string, string>; body: string }) => UpstreamResponse | undefined) {
    this.handler = handler;
  }

  async fetch(url: string, init: { method: string; headers: Record<string, string>; body?: string | Uint8Array | null }): Promise<UpstreamResponse> {
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers)) lower[k.toLowerCase()] = v;
    const body = typeof init.body === "string" ? init.body : init.body ? Buffer.from(init.body).toString("utf8") : undefined;
    this.requests.push({ url, method: init.method, headers: lower, body });
    if (this.handler) {
      const custom = this.handler({ url, headers: lower, body: body ?? "" });
      if (custom) return custom;
    }
    return this.response;
  }
}

function account(overrides: Partial<ProviderAccountLike> = {}): ProviderAccountLike {
  return {
    id: "acct", userId: "", provider: "p", name: "acct", accessToken: "", refreshToken: "", expiresAt: new Date(),
    apiKey: null, projectId: null, tier: null, accountId: null, email: null, isActive: true,
    disabledUntil: null, lastUsedAt: null, status: "active", ...overrides,
  };
}

const registry = Registry.load();

describe("kiro buildRequest (ported from kiro_test.go)", () => {
  it("converts messages and tools", () => {
    const provider = new KiroProvider(null);
    const payload = provider.buildRequest({
      model: "kiro/unit-test-model",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "", tool_calls: [{ id: "toolu_1", function: { name: "lookup", arguments: `{"city":"Jakarta"}` } }] },
        { role: "tool", tool_call_id: "toolu_1", content: "sunny" },
      ],
      tools: [{ type: "function", function: { name: "lookup", description: "Lookup", parameters: { type: "object" } } }],
    });
    const state = payload["conversationState"] as Record<string, unknown>;
    const history = state["history"] as unknown[];
    expect(history).toHaveLength(2);
    const current = (state["currentMessage"] as Record<string, unknown>)["userInputMessage"] as Record<string, unknown>;
    expect(current["content"]).toBe("Tool results provided.");
    const ctx = current["userInputMessageContext"] as Record<string, unknown>;
    expect((ctx["tools"] as unknown[]).length).toBe(1);
    const toolResults = ctx["toolResults"] as unknown[];
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as Record<string, unknown>)["toolUseId"]).toBe("toolu_1");
  });

  it("attaches tool results to next user", () => {
    const provider = new KiroProvider(null);
    const payload = provider.buildRequest({
      model: "kiro/unit-test-model",
      messages: [
        { role: "user", content: "read file" },
        { role: "assistant", content: "", tool_calls: [{ id: "toolu_1", function: { name: "read", arguments: `{"path":"a.txt"}` } }] },
        { role: "tool", tool_call_id: "toolu_1", content: "file contents" },
        { role: "user", content: "summarize it" },
      ],
    });
    const state = payload["conversationState"] as Record<string, unknown>;
    const history = state["history"] as unknown[];
    const assistant = (history[1] as Record<string, unknown>)["assistantResponseMessage"] as Record<string, unknown>;
    expect((assistant["toolUses"] as unknown[])).toHaveLength(1);
    const current = (state["currentMessage"] as Record<string, unknown>)["userInputMessage"] as Record<string, unknown>;
    expect(current["content"]).toBe("summarize it");
    const currentResults = (current["userInputMessageContext"] as Record<string, unknown>)["toolResults"] as unknown[];
    expect(currentResults).toHaveLength(1);
    expect((currentResults[0] as Record<string, unknown>)["toolUseId"]).toBe("toolu_1");
  });

  it("inserts synthetic user for tool results before assistant", () => {
    const provider = new KiroProvider(null);
    const payload = provider.buildRequest({
      model: "kiro/unit-test-model",
      messages: [
        { role: "user", content: "read file" },
        { role: "assistant", content: "", tool_calls: [{ id: "toolu_1", function: { name: "read", arguments: `{"path":"a.txt"}` } }] },
        { role: "tool", tool_call_id: "toolu_1", content: "file contents" },
        { role: "assistant", content: "I read it." },
        { role: "user", content: "continue" },
      ],
    });
    const state = payload["conversationState"] as Record<string, unknown>;
    const history = state["history"] as unknown[];
    expect(history).toHaveLength(4);
    const toolResultUser = (history[2] as Record<string, unknown>)["userInputMessage"] as Record<string, unknown>;
    expect(toolResultUser["content"]).toBe("Tool results provided.");
    const results = (toolResultUser["userInputMessageContext"] as Record<string, unknown>)["toolResults"] as unknown[];
    expect(results).toHaveLength(1);
    expect((results[0] as Record<string, unknown>)["toolUseId"]).toBe("toolu_1");
    const secondAssistant = (history[3] as Record<string, unknown>)["assistantResponseMessage"] as Record<string, unknown>;
    expect(secondAssistant["content"]).toBe("I read it.");
  });

  it("strips orphaned tool uses", () => {
    const provider = new KiroProvider(null);
    const payload = provider.buildRequest({
      model: "kiro/unit-test-model",
      messages: [
        { role: "user", content: "read file" },
        { role: "assistant", content: "", tool_calls: [{ id: "toolu_missing", function: { name: "read", arguments: `{"path":"a.txt"}` } }] },
        { role: "user", content: "ignore that" },
      ],
    });
    const state = payload["conversationState"] as Record<string, unknown>;
    const history = state["history"] as unknown[];
    const assistant = (history[1] as Record<string, unknown>)["assistantResponseMessage"] as Record<string, unknown>;
    expect(assistant["toolUses"]).toBeUndefined();
  });

  it("does not inject thinking into tool results", () => {
    const provider = new KiroProvider(null);
    const payload = provider.buildRequest({
      model: "kiro/unit-test-model",
      _includeReasoning: true,
      messages: [
        { role: "system", content: "follow policy" },
        { role: "assistant", content: "", tool_calls: [{ id: "toolu_1", function: { name: "read", arguments: `{"path":"a.txt"}` } }] },
        { role: "tool", tool_call_id: "toolu_1", content: "file contents" },
      ],
    });
    const state = payload["conversationState"] as Record<string, unknown>;
    const current = (state["currentMessage"] as Record<string, unknown>)["userInputMessage"] as Record<string, unknown>;
    expect(String(current["content"])).not.toContain("<thinking_mode>");
    expect(current["content"]).toBe("Tool results provided.");
  });

  it("injects system thinking and anthropic tools", () => {
    const provider = new KiroProvider(null);
    const payload = provider.buildRequest({
      model: "kiro/unit-test-model",
      _includeReasoning: true,
      thinking_budget: 1234,
      messages: [
        { role: "system", content: "follow policy" },
        { role: "user", content: "hello" },
      ],
      tools: [{ name: "lookup", description: "Lookup", input_schema: { type: "object" } }],
    });
    const state = payload["conversationState"] as Record<string, unknown>;
    const current = (state["currentMessage"] as Record<string, unknown>)["userInputMessage"] as Record<string, unknown>;
    const content = String(current["content"]);
    expect(content).toContain("<thinking_mode>enabled</thinking_mode><max_thinking_length>1234</max_thinking_length>");
    expect(content).toContain("follow policy");
    expect(content).toContain("hello");
    const tools = (current["userInputMessageContext"] as Record<string, unknown>)["tools"] as unknown[];
    const spec = (tools[0] as Record<string, unknown>)["toolSpecification"] as Record<string, unknown>;
    expect(spec["name"]).toBe("lookup");
  });

  it("uses reasoning budget from thinking_budget", () => {
    const provider = new KiroProvider(null);
    const payload = provider.buildRequest({
      model: "kiro/unit-test-model",
      thinking_budget: 5000,
      messages: [{ role: "user", content: "hello" }],
    });
    const state = payload["conversationState"] as Record<string, unknown>;
    const current = (state["currentMessage"] as Record<string, unknown>)["userInputMessage"] as Record<string, unknown>;
    expect(String(current["content"])).toContain("<max_thinking_length>5000</max_thinking_length>");
  });
});

describe("codex buildPayload (ported from oauth_providers_test.go)", () => {
  it("converts chat to responses payload", () => {
    const provider = new CodexProvider(null, null, null);
    const model = "unit-test-model";
    const payload = provider.buildPayload({
      model: `codex/${model}`,
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
      ],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      reasoning_effort: "medium",
      _includeReasoning: true,
      _sessionId: "sess_1",
    }, model, true);

    expect(payload["model"]).toBe(model);
    expect(payload["store"]).toBe(false);
    expect(payload["stream"]).toBe(true);
    expect(payload["instructions"]).toBe("be terse");
    const input = payload["input"] as unknown[];
    expect(input).toHaveLength(2);
    expect((input[0] as Record<string, unknown>)["role"]).toBe("developer");
    const reasoning = payload["reasoning"] as Record<string, unknown>;
    expect(reasoning["effort"]).toBe("medium");
    expect(reasoning["summary"]).toBe("auto");
    expect(payload["prompt_cache_key"]).toBe("sess_1");
  });

  it("extracts account id from JWT organizations", () => {
    const token = "x." + Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { organizations: [{ id: "org_1", is_default: true }] } })).toString("base64url") + ".y";
    expect(extractAccountIDFromJWT(token)).toBe("org_1");
  });

  it("extracts tier from JWT", () => {
    const token = "x." + Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_plan_type: "PLUS" } })).toString("base64url") + ".y";
    expect(extractTierFromJWT(token)).toBe("plus");
    const fallback = "x." + Buffer.from(JSON.stringify({ chatgpt_plan_type: "self_serve_business_usage_based" })).toString("base64url") + ".y";
    expect(extractTierFromJWT(fallback)).toBe("self_serve_business_usage_based");
  });

  it("nil registry allows caller-validated model", () => {
    const provider = new CodexProvider(null, null, null);
    expect(provider.isModelAllowed("anything-without-registry")).toBe(true);
  });
});

describe("gemini transforms (ported from oauth_providers_test.go)", () => {
  it("converts OpenAI messages to gemini payload", () => {
    const payload = openAIToGemini({
      messages: [
        { role: "system", content: "policy" },
        { role: "user", content: "hello" },
      ],
      temperature: 0.3,
      max_tokens: 64,
    });
    expect(payload["systemInstruction"]).not.toBeUndefined();
    const contents = payload["contents"] as unknown[];
    expect(contents).toHaveLength(1);
    expect((contents[0] as Record<string, unknown>)["role"]).toBe("user");
    const generation = payload["generationConfig"] as Record<string, unknown>;
    expect(generation["temperature"]).toBe(0.3);
    expect(generation["maxOutputTokens"]).toBe(64);
  });

  it("completion includes thought parts as reasoning", () => {
    const completion = geminiToOpenAICompletion(
      { candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { text: "answer" }] } }] },
      "unit-test-model",
      new Map(),
    );
    const message = ((completion["choices"] as unknown[])[0] as Record<string, unknown>)["message"] as Record<string, unknown>;
    expect(message["content"]).toBe("answer");
    expect(message["reasoning_content"]).toBe("thinking");
  });

  it("normalizes tool args, finish and usage", () => {
    const schemas: ToolSchemaMap = new Map([
      ["lookup", new Map([["items", { typ: "array" }], ["query", { typ: "string" }]])],
    ]);
    const response = {
      candidates: [{
        finishReason: "MAX_TOKENS",
        content: { parts: [{ functionCall: { name: "lookup", id: "call_1", args: { items: "[1,2]", query: "line\\nbreak" } } }] },
      }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
    };
    const completion = geminiToOpenAICompletion(response, "gemini-test", schemas);
    const choice = (completion["choices"] as unknown[])[0] as Record<string, unknown>;
    expect(choice["finish_reason"]).toBe("tool_calls");
    const message = choice["message"] as Record<string, unknown>;
    const call = ((message["tool_calls"] as unknown[])[0] as Record<string, unknown>);
    const args = ((call["function"] as Record<string, unknown>)["arguments"]) as string;
    const parsedArgs = JSON.parse(args) as Record<string, unknown>;
    expect(parsedArgs["items"]).toEqual([1, 2]);
    expect(parsedArgs["query"]).toBe("line\nbreak");
    expect(completion["usage"]).toEqual({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
  });

  it("tool history parity keeps completed calls only", () => {
    const payload = openAIToGemini({
      messages: [
        { role: "user", content: "use tools" },
        { role: "assistant", content: "thinking", tool_calls: [
          { id: "call_keep", type: "function", function: { name: "lookup", arguments: `{"items":"[1,2]"}` } },
          { id: "call_orphan", type: "function", function: { name: "lookup", arguments: `{}` } },
        ] },
        { role: "tool", tool_call_id: "call_keep", name: "lookup", content: "ok" },
        { role: "tool", tool_call_id: "missing", name: "lookup", content: "bad" },
      ],
      stop: ["END"],
      reasoning_effort: "low",
      include_thoughts: true,
    });
    const contents = payload["contents"] as unknown[];
    expect(contents).toHaveLength(4);
    const callParts = (contents[2] as Record<string, unknown>)["parts"] as unknown[];
    expect(callParts).toHaveLength(1);
    const call = ((callParts[0] as Record<string, unknown>)["functionCall"]) as Record<string, unknown>;
    expect(call["id"]).toBe("call_keep");
    expect(call["name"]).toBe("lookup");
    const response = ((contents[3] as Record<string, unknown>)["parts"] as unknown[])[0] as Record<string, unknown>;
    expect((response["functionResponse"] as Record<string, unknown>)["id"]).toBe("call_keep");
    const generation = payload["generationConfig"] as Record<string, unknown>;
    expect((generation["stopSequences"] as unknown[])[0]).toBe("END");
    const thinking = generation["thinkingConfig"] as Record<string, unknown>;
    expect(thinking["thinkingBudget"]).toBe(1024);
    expect(thinking["include_thoughts"]).toBe(true);
  });

  it("scrubs tool transcript artifacts", () => {
    const text = "ok\nTool: read\n```\nthought: hidden\n```\ndone";
    const cleaned = scrubToolTranscriptArtifacts(text);
    expect(cleaned).not.toContain("Tool:");
    expect(cleaned).not.toContain("thought:");
  });

  it("injects gemini tool instruction", () => {
    const payload: Record<string, unknown> = { tools: [{ functionDeclarations: [{ name: "lookup" }] }] };
    injectGeminiToolInstruction(payload);
    const system = payload["systemInstruction"] as Record<string, unknown>;
    const text = ((system["parts"] as unknown[])[0] as Record<string, unknown>)["text"] as string;
    expect(text).toContain("CRITICAL_TOOL_USAGE_INSTRUCTIONS");
  });
});

describe("antigravity config (ported from oauth_providers_test.go)", () => {
  it("v1 endpoint order and defaults", () => {
    const provider = new GoogleCodeAssistProvider(antigravityDelegateConfig(registry, null, null));
    expect(provider.endpoints).toEqual([
      "https://daily-cloudcode-pa.googleapis.com",
      "https://autopush-cloudcode-pa.sandbox.googleapis.com",
      "https://cloudcode-pa.googleapis.com",
    ]);
    expect(provider.defaultProject).toBe("rising-fact-p41fc");
  });

  it("generation headers include code assist metadata", () => {
    const provider = new GoogleCodeAssistProvider(antigravityDelegateConfig(registry, null, null));
    const headers = provider.googleGenerationHeaders(" token ", true);
    expect(headers["authorization"]).toBe("Bearer token");
    expect(headers["accept"]).toBe("text/event-stream");
    expect(headers["user-agent"]).toContain("antigravity/");
    expect(headers["x-goog-api-client"]).toBe("google-cloud-sdk vscode_cloudshelleditor/0.1");
    expect(headers["client-metadata"]).toBe('{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}');
  });

  it("wrap payload uses official fields", () => {
    const provider = new GoogleCodeAssistProvider(antigravityDelegateConfig(registry, null, null));
    const payload = provider.wrapCodeAssistPayload("project-1", "gemini-3-flash", { contents: [] });
    expect(payload["userAgent"]).toBe("antigravity");
    expect(payload["requestType"]).toBe("agent");
    expect(String(payload["requestId"])).toMatch(/^agent-/);
    expect(payload["enabledCreditTypes"]).toBeUndefined();
  });

  it("gemini 3.5 flash resolves from registry", () => {
    const provider = new GoogleCodeAssistProvider(antigravityDelegateConfig(registry, null, null));
    expect(provider.resolveModel("gemini-3.5-flash")).toBe("gemini-3.5-flash-medium");
    expect(provider.resolveAntigravityGemini3ModelVariant("gemini-3.5-flash-medium", { reasoning_effort: "low" })).toBe("gemini-3.5-flash-low");
    expect(provider.resolveAntigravityGemini3ModelVariant("gemini-3.5-flash-medium", {})).toBe("gemini-3.5-flash-medium");
  });

  it("drops unsupported logit_bias", () => {
    const provider = new GoogleCodeAssistProvider(antigravityDelegateConfig(registry, null, null));
    const model = provider.resolveModel("gemini-3.5-flash");
    const normalized = provider.normalizeBodyForModel({ model, messages: [{ role: "user", content: "hi" }], logit_bias: { "12429": -50 } }, model);
    expect(normalized["logit_bias"]).toBeUndefined();
  });
});

describe("provider request building (ported from oauth_providers_test.go)", () => {
  it("opencode sends public auth and client headers", async () => {
    const provider = new OpencodeProvider(registry);
    const client = new CaptureClient();
    let capturedHeaders: Record<string, string> = {};
    client.onRequest(({ headers }) => {
      capturedHeaders = headers;
      return undefined;
    });
    const model = registry.modelsForProvider("opencode")[0]!;
    const resp = await provider.makeRequest(client, {}, "", account(), {
      model: `opencode/${model}`,
      messages: [{ role: "user", content: "hello" }],
      _sessionId: "sess_1",
      _projectId: "global",
    }, false);
    expect(resp.status).toBe(200);
    expect(capturedHeaders["authorization"]).toBe("Bearer public");
    expect(capturedHeaders["x-opencode-session"]).toBe("sess_1");
    expect(capturedHeaders["x-opencode-project"]).toBe("global");
    expect(capturedHeaders["x-opencode-request"]).not.toBe("");
    expect(capturedHeaders["x-opencode-client"]).toBe("cli");
    expect(capturedHeaders["user-agent"]).toBe("opencode/1.15.8");
  });

  it("omits auth for authless kilo model", async () => {
    const provider = new OpenAICompatibleProvider({ name: "kilo_code", baseURL: "https://api.kilo.test/api/gateway", supportedParams: new Set(["model", "messages", "stream"]), registry, trimPrefix: "kilo_code/" });
    const client = new CaptureClient();
    let authorization: string | undefined;
    client.onRequest(({ headers }) => {
      authorization = headers["authorization"];
      return undefined;
    });
    // find an authless kilo_code model
    let model = "";
    for (const m of registry.allModels()) {
      if (registry.isAuthlessProviderModel(m, "kilo_code")) {
        model = m;
        break;
      }
    }
    if (!model) return; // no authless kilo model in registry
    const resp = await provider.makeRequest(client, {}, "", account(), { model: `kilo_code/${model}`, messages: [{ role: "user", content: "hello" }] }, false);
    expect(resp.status).toBe(200);
    expect(authorization).toBeUndefined();
  });

  it("keeps auth for kilo account", async () => {
    const provider = new OpenAICompatibleProvider({ name: "kilo_code", baseURL: "https://api.kilo.test/api/gateway", supportedParams: new Set(["model", "messages", "stream"]), registry, trimPrefix: "kilo_code/" });
    const client = new CaptureClient();
    let authorization: string | undefined;
    client.onRequest(({ headers }) => {
      authorization = headers["authorization"];
      return undefined;
    });
    const model = registry.modelsForProvider("kilo_code")[0];
    if (!model) return;
    const resp = await provider.makeRequest(client, {}, "token", account(), { model: `kilo_code/${model}`, messages: [{ role: "user", content: "hello" }] }, false);
    expect(resp.status).toBe(200);
    expect(authorization).toBe("Bearer token");
  });

  it("workers ai converts image URL to data URI", async () => {
    const provider = new WorkersAIProvider(registry);
    const client = new CaptureClient();
    client.onRequest(({ url }) => {
      if (url.startsWith("https://8.8.8.8/")) {
        return { status: 200, headers: { "content-type": "image/png" }, body: streamFromString("png") };
      }
      return undefined;
    });
    const model = registry.modelsForProvider("workers_ai")[0];
    if (!model) return;
    const resp = await provider.makeRequest(client, {}, "token", account({ accountId: "acct_123" }), {
      model: `workers_ai/${model}`,
      messages: [{ role: "user", content: [{ type: "text", text: "describe" }, { type: "image_url", image_url: { url: "https://8.8.8.8/image.png" } }] }],
    }, false);
    expect(resp.status).toBe(200);
    const captured = client.requests[client.requests.length - 1]!;
    const payload = JSON.parse(captured.body ?? "{}") as Record<string, unknown>;
    const messages = payload["messages"] as unknown[];
    const content = (messages[0] as Record<string, unknown>)["content"] as unknown[];
    const imageURL = (content[1] as Record<string, unknown>)["image_url"] as Record<string, unknown>;
    expect(String(imageURL["url"])).toMatch(/^data:image\/png;base64,/);
  });

  it("rejects unsafe image urls", async () => {
    expect(await isSafeExternalURL("http://127.0.0.1/image.png")).toBe(false);
    expect(await isSafeExternalURL("http://10.0.0.1/image.png")).toBe(false);
    expect(await isSafeExternalURL("http://192.168.1.1/image.png")).toBe(false);
    expect(await isSafeExternalURL("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(await isSafeExternalURL("https://8.8.8.8/image.png")).toBe(true);
  });
});
