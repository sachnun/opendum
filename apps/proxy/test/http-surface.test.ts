import { describe, expect, it, beforeAll } from "vitest";
import { createApp } from "../src/index.js";
import { Registry } from "../src/registry/index.js";
import type { Provider, ProviderAccountLike, UpstreamResponse } from "../src/providers/types.js";
import { jsonResponse, streamFromString } from "../src/providers/http.js";
import { playgroundSignature } from "../src/service.js";

const SECRET = "test-secret";

class StubProvider implements Provider {
  authless(): boolean {
    return true;
  }
  async makeRequest(_client: never, _ctx: never, _credentials: string, _account: ProviderAccountLike, _body: Record<string, unknown>, stream: boolean): Promise<UpstreamResponse> {
    if (stream) {
      return {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: streamFromString('data: {"id":"chatcmpl-stub","choices":[{"index":0,"delta":{"content":"stub response"},"finish_reason":null}]}\n\ndata: [DONE]\n\n'),
      };
    }
    return jsonResponse(200, {
      id: "chatcmpl-stub",
      object: "chat.completion",
      model: "stub-model",
      choices: [{ index: 0, message: { role: "assistant", content: "stub response" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
  }
}

const registry = Registry.load();
const opencodeModel = registry.modelsForProvider("opencode")[0]!;

let app: ReturnType<typeof createApp>["app"];
let svc: ReturnType<typeof createApp>["svc"];

beforeAll(() => {
  const created = createApp({
    db: null,
    redis: null,
    secret: SECRET,
    registry,
    config: {
      host: "0.0.0.0",
      port: 4001,
      databaseUrl: "postgres://unused",
      redisUrl: "redis://unused",
      betterAuthSecret: SECRET,
      modelsDir: "",
      tokenRefreshIntervalSeconds: 0,
    },
  });
  app = created.app;
  svc = created.svc;
  svc.providerRegistry.register("opencode", new StubProvider());
});

function playgroundHeaders(path: string, body: unknown): Headers {
  const userId = "user_1";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = playgroundSignature(SECRET, userId, timestamp, "POST", path);
  return new Headers({
    "X-Opendum-Playground-User-Id": userId,
    "X-Opendum-Playground-Timestamp": timestamp,
    "X-Opendum-Playground-Signature": signature,
    "content-type": "application/json",
  });
}

describe("proxy HTTP surface (golden)", () => {
  it("GET /v1 models list is OpenAI format", async () => {
    const response = await app.request("/v1/models");
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { object: string; data: Array<Record<string, unknown>> };
    expect(payload.object).toBe("list");
    expect(payload.data.length).toBeGreaterThan(50);
    const first = payload.data[0]!;
    expect(first["object"]).toBe("model");
    expect(typeof first["created"]).toBe("number");
    expect(typeof first["owned_by"]).toBe("string");
  });

  it("GET /v1 unknown endpoint returns OpenAI error", async () => {
    const response = await app.request("/v1/nope");
    expect(response.status).toBe(404);
    const payload = (await response.json()) as { error: { message: string; type: string } };
    expect(payload.error.message).toBe("Unknown API endpoint.");
    expect(payload.error.type).toBe("invalid_request_error");
  });

  it("GET / redirects to /v1", async () => {
    const response = await app.request("/");
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("/v1");
  });

  it("POST /v1/chat/completions streams via playground auth", async () => {
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: playgroundHeaders("/v1/chat/completions", {}),
      body: JSON.stringify({ model: opencodeModel, stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-provider-account-id")).toBe("opencode");
    const text = await response.text();
    expect(text).toContain('"content":"stub response"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("POST /v1/chat/completions non-stream returns JSON", async () => {
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: playgroundHeaders("/v1/chat/completions", {}),
      body: JSON.stringify({ model: opencodeModel, stream: false, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload["id"]).toBe("chatcmpl-stub");
    expect((payload["choices"] as unknown[])[0]).toMatchObject({ finish_reason: "stop" });
  });

  it("POST /v1/messages formats errors as anthropic", async () => {
    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: playgroundHeaders("/v1/messages", {}),
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { type: string; error: { message: string; type: string } };
    expect(payload.type).toBe("error");
    expect(payload.error.message).toBe("model is required");
    expect(payload.error.type).toBe("invalid_request_error");
  });

  it("POST /v1/chat/completions rejects invalid playground auth", async () => {
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "X-Opendum-Playground-User-Id": "u", "X-Opendum-Playground-Timestamp": "1", "X-Opendum-Playground-Signature": "bad", "content-type": "application/json" },
      body: JSON.stringify({ model: opencodeModel, messages: [] }),
    });
    expect(response.status).toBe(401);
    const payload = (await response.json()) as { error: { message: string; type: string } };
    expect(payload.error.message).toBe("Invalid playground session");
    expect(payload.error.type).toBe("authentication_error");
  });

  it("POST /internal/quota rejects bad signature", async () => {
    const response = await app.request("/internal/quota", {
      method: "POST",
      headers: { "X-Opendum-Internal-Timestamp": "1", "X-Opendum-Internal-Signature": "bad" },
      body: JSON.stringify({ userId: "u", provider: "codex", accountId: "a" }),
    });
    expect(response.status).toBe(401);
    const payload = (await response.json()) as { success: boolean; error: string };
    expect(payload.success).toBe(false);
    expect(payload.error).toBe("Invalid internal quota signature");
  });
});

describe("SSE chunk sequence (golden)", () => {
  it("passes through upstream SSE chunks in order", async () => {
    const chunks: string[] = [];
    const stub: Provider & { authless(): boolean } = {
      authless: () => true,
      async makeRequest(): Promise<UpstreamResponse> {
        chunks.push("upstream-1");
        return {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: streamFromString('data: {"id":"a","choices":[{"delta":{"content":"one"}}]}\n\ndata: {"id":"a","choices":[{"delta":{"content":"two"}}]}\n\ndata: [DONE]\n\n'),
        };
      },
    };
    svc.providerRegistry.register("opencode", stub);
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: playgroundHeaders("/v1/chat/completions", {}),
      body: JSON.stringify({ model: opencodeModel, stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    const text = await response.text();
    expect(text).toContain('"content":"one"');
    expect(text).toContain('"content":"two"');
    expect(text).toContain("data: [DONE]");
    expect(chunks).toHaveLength(1);
  });
});
