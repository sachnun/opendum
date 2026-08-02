import { describe, expect, it } from "vitest";
import { Registry } from "../src/registry/index.js";
import { qoderEncodeBody, buildQoderAuthHeaders, qoderSigPath, splitQoderAccountID } from "../src/providers/qoder.js";
import { buildCommandCodeEnvelope } from "../src/providers/command_code.js";
import { MimoCodeProvider } from "../src/providers/mimo_code.js";
import type { HttpClient, UpstreamResponse } from "../src/providers/types.js";
import { streamFromString } from "../src/providers/http.js";

const registry = Registry.load();

describe("registry parity (ported from registry_test.go)", () => {
  it("workers ai models declare cloudflare upstream", () => {
    const map = registry.providerModelMapFor("workers_ai");
    expect(map.size).toBeGreaterThan(0);
    for (const [model, upstream] of map) {
      expect(upstream).not.toBe(model);
      expect(upstream.startsWith("@")).toBe(true);
    }
  });

  it("kilo code only exposes free authless models", () => {
    for (const model of ["kilo-auto-free", "kilo-auto-small", "kilo-auto-balanced", "kilo-auto-frontier"]) {
      expect(registry.isSupportedByProvider(model, "kilo_code")).toBe(false);
    }
    const map = registry.providerModelMapFor("kilo_code");
    expect(map.size).toBeGreaterThan(0);
    for (const [model, upstream] of map) {
      expect(upstream.endsWith(":free") || upstream === "openrouter/free" || upstream === "openrouter/owl-alpha").toBe(true);
      expect(registry.isAuthlessProviderModel(model, "kilo_code")).toBe(true);
    }
  });

  it("nvidia mistral alias uses current hosted model", () => {
    expect(registry.resolveAlias("mistralai/mistral-large")).toBe("mistral-large-3");
    expect(registry.resolveAlias("mistral-large-3-675b-instruct-2512")).toBe("mistral-large-3");
    expect(registry.upstreamModelName("mistralai/mistral-large", "nvidia_nim")).toBe("mistralai/mistral-large");
    expect(registry.providerModelMapFor("nvidia_nim").has("mistral-large")).toBe(false);
  });

  it("nemotron omni alias uses current hosted model", () => {
    for (const alias of ["nemotron-3-nano-omni-30b-a3b-reasoning", "nemotron-omni", "nano-omni"]) {
      expect(registry.resolveAlias(alias)).toBe("nemotron-3-nano-omni");
      expect(registry.upstreamModelName(alias, "nvidia_nim")).toBe("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning");
    }
  });

  it("deepseek v4 aliases resolve to canonical", () => {
    for (const alias of ["deepseek-flash", "deepseek-v4-flash", "deepseek-ai/deepseek-v4-flash", "deepseek-v4-flash-free", "deepseek-ai/DeepSeek-V4-Flash"]) {
      expect(registry.resolveAlias(alias)).toBe("deepseek-v4-flash");
      expect(registry.isSupported(alias)).toBe(true);
    }
    for (const alias of ["deepseek-pro", "deepseek-v4-pro", "deepseek-ai/deepseek-v4-pro", "deepseek-ai/DeepSeek-V4-Pro"]) {
      expect(registry.resolveAlias(alias)).toBe("deepseek-v4-pro");
      expect(registry.isSupported(alias)).toBe(true);
    }
  });

  it("provider aliases use configured upstreams", () => {
    let checked = 0;
    for (const canonical of registry.allModels()) {
      const info = registry.modelInfo(canonical);
      if (!info) continue;
      const aliases = registry.lookupKeys(canonical);
      for (const [provider, cfg] of Object.entries(info.providerConfig)) {
        if (cfg.upstream === "" || !info.providers.includes(provider)) continue;
        checked++;
        for (const alias of aliases) {
          if (registry.resolveAlias(alias) !== canonical) continue;
          expect(registry.upstreamModelName(alias, provider)).toBe(cfg.upstream);
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("qoder (ported from qoder_test.go)", () => {
  it("encode body roundtrip scrambles and strips padding", () => {
    const plaintext = JSON.stringify({ model: "qmodel_latest", messages: [] });
    const encoded = qoderEncodeBody(plaintext);
    expect(encoded).not.toBe("");
    expect(encoded).not.toBe(Buffer.from(plaintext).toString("base64"));
    expect(encoded).not.toContain("=");
  });

  it("auth headers are complete", () => {
    const headers = buildQoderAuthHeaders(Buffer.from("body"), "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1", "uid-123", "mid-456", "dt-token");
    const required = [
      "authorization", "cosy-key", "cosy-user", "cosy-date", "cosy-version",
      "cosy-machineid", "cosy-machinetoken", "cosy-machinetype", "cosy-machineos",
      "cosy-clienttype", "cosy-clientip", "cosy-bodyhash", "cosy-bodylength",
      "cosy-sigpath", "cosy-data-policy", "login-version", "x-request-id",
      "content-type", "accept",
    ];
    for (const key of required) {
      expect(headers[key] ?? "").not.toBe("");
    }
    expect(headers["authorization"]).toMatch(/^Bearer COSY\./);
    expect(headers["cosy-user"]).toBe("uid-123");
    expect(headers["cosy-machineid"]).toBe("mid-456");
  });

  it("sig path strips algo prefix", () => {
    expect(qoderSigPath("https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1")).toBe("/api/v2/service/pro/sse/agent_chat_generation");
    expect(qoderSigPath("https://api3.qoder.sh/algo/api/v2/model/list")).toBe("/api/v2/model/list");
  });

  it("split account id", () => {
    expect(splitQoderAccountID("uid|machine")).toEqual(["uid", "machine"]);
    expect(splitQoderAccountID("only")).toEqual(["only", "only"]);
  });
});

describe("command code envelope (ported from command_code_test.go)", () => {
  it("extracts system and converts messages", () => {
    const envelope = buildCommandCodeEnvelope({
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "hi" },
        { role: "assistant", content: "ok", tool_calls: [{ id: "call_1", function: { name: "search", arguments: `{"q":"x"}` } }] },
        { role: "tool", tool_call_id: "call_1", content: "result" },
      ],
      tools: [{ type: "function", function: { name: "search", description: "Search the web", parameters: { type: "object", properties: {} } } }],
      max_tokens: 100,
      temperature: 0.5,
    }, "moonshotai/Kimi-K2.7-Code");

    const params = envelope["params"] as Record<string, unknown>;
    expect(params["model"]).toBe("moonshotai/Kimi-K2.7-Code");
    expect(params["system"]).toBe("Be terse.");
    expect(params["max_tokens"]).toBe(100);
    expect(params["temperature"]).toBe(0.5);
    const messages = params["messages"] as unknown[];
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({ role: "user", content: "hi" });
    const assistant = messages[1] as Record<string, unknown>;
    expect(assistant["role"]).toBe("assistant");
    const parts = assistant["content"] as unknown[];
    expect(parts).toContainEqual({ type: "tool-call", toolCallId: "call_1", toolName: "search", input: `{"q":"x"}` });
    const tool = messages[2] as Record<string, unknown>;
    expect((tool["content"] as unknown[])[0]).toMatchObject({ type: "tool-result", toolCallId: "call_1", toolName: "search" });
  });
});

describe("mimo code (ported from mimo_code_test.go)", () => {
  it("sends marker and source headers", async () => {
    const client: HttpClient = {
      async fetch(url, init) {
        if (url.includes("/api/free-ai/bootstrap")) {
          return { status: 200, headers: {}, body: streamFromString(`{"jwt":"test.jwt.token"}`) };
        }
        if (url.includes("/api/free-ai/openai/chat")) {
          const body = JSON.parse(typeof init.body === "string" ? init.body : "") as Record<string, unknown>;
          const messages = body["messages"] as unknown[];
          const first = messages[0] as Record<string, unknown>;
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(init.headers)) headers[k.toLowerCase()] = v;
          expect(messages).toHaveLength(2);
          expect(first["role"]).toBe("system");
          expect(String(first["content"])).toContain("MiMoCode");
          expect(headers["authorization"]).toBe("Bearer test.jwt.token");
          expect(headers["x-mimo-source"]).toBe("mimocode-cli-free");
          expect(headers["x-session-affinity"]).toMatch(/^ses_[a-z0-9]{24}$/);
          return { status: 200, headers: {}, body: streamFromString(`{"id":"resp","choices":[]}`) };
        }
        throw new Error(`unexpected url: ${url}`);
      },
    };
    const provider = new MimoCodeProvider(registry);
    const resp = await provider.makeRequest(client, {}, "", {} as never, { model: "mimo_code/mimo-auto", messages: [{ role: "user", content: "hi" }] }, false);
    expect(resp.status).toBe(200);
  });

  it("marker injection is idempotent", async () => {
    const client: HttpClient = {
      async fetch(url, init) {
        if (url.includes("/bootstrap")) {
          return { status: 200, headers: {}, body: streamFromString(`{"jwt":"test.jwt.token"}`) };
        }
        if (url.includes("/chat")) {
          const body = JSON.parse(typeof init.body === "string" ? init.body : "") as Record<string, unknown>;
          const messages = body["messages"] as unknown[];
          // already contains marker → no duplicate injected
          expect(messages).toHaveLength(1);
          return { status: 200, headers: {}, body: streamFromString(`{"id":"resp","choices":[]}`) };
        }
        throw new Error(`unexpected url: ${url}`);
      },
    };
    const provider = new MimoCodeProvider(registry);
    await provider.makeRequest(client, {}, "", {} as never, {
      model: "mimo_code/mimo-auto",
      messages: [{ role: "system", content: "You are MiMoCode, an interactive CLI tool that helps users with software engineering tasks." }],
    }, false);
  });
});
