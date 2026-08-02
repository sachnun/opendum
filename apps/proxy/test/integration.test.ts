import { describe, expect, it } from "vitest";
import { ProxyService } from "../src/service.js";
import { AuthService } from "../src/auth/service.js";
import { AuthModelService } from "../src/auth/models.js";
import { Registry } from "../src/registry/index.js";
import type { Provider, ProviderAccountLike, UpstreamResponse } from "../src/providers/types.js";
import { jsonResponse, streamFromString } from "../src/providers/http.js";
import { playgroundSignature } from "../src/service.js";
import { readAllText } from "../src/providers/http.js";

const SECRET = "test-secret";

class StubProvider implements Provider {
  constructor(private respond: (body: Record<string, unknown>, stream: boolean) => UpstreamResponse) {}

  authless(): boolean {
    return true;
  }

  async makeRequest(_client: never, _ctx: never, _credentials: string, _account: ProviderAccountLike, body: Record<string, unknown>, stream: boolean): Promise<UpstreamResponse> {
    return this.respond(body, stream);
  }
}

function makeService(respond: (body: Record<string, unknown>, stream: boolean) => UpstreamResponse): ProxyService {
  const registry = Registry.load();
  const svc = new ProxyService(null, null, new AuthService(null, null, registry), new AuthModelService(null, null, registry), registry, SECRET);
  svc.providerRegistry.register("opencode", new StubProvider(respond));
  return svc;
}

function playgroundRequest(path: string, method: string, body: unknown): Request {
  const userId = "test-user-1";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = playgroundSignature(SECRET, userId, timestamp, method, path);
  return new Request("http://localhost" + path, {
    method,
    headers: {
      "X-Opendum-Playground-User-Id": userId,
      "X-Opendum-Playground-Timestamp": timestamp,
      "X-Opendum-Playground-Signature": signature,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function opencodeModel(): string {
  const registry = Registry.load();
  return registry.modelsForProvider("opencode")[0] ?? "opencode/gpt-5";
}

describe("proxy service integration", () => {
  it("chat completions non-stream passes through provider response", async () => {
    const model = opencodeModel();
    const svc = makeService((body) => {
      expect(body["model"]).toBe(model);
      expect(body["stream"]).toBe(false);
      expect(body["_includeReasoning"]).toBe(false);
      return jsonResponse(200, { id: "chatcmpl-1", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    });

    const result = await svc.handle(playgroundRequest("/v1/chat/completions", "POST", { model, messages: [{ role: "user", content: "hello" }] }), svc.chatCompletionsConfig());
    expect(result.status).toBe(200);
    expect(result.headers["x-provider-account-id"]).toBe("opencode");
    const text = typeof result.body === "string" ? result.body : await readAllText(result.body);
    expect(JSON.parse(text)).toMatchObject({ id: "chatcmpl-1", model });
  });

  it("streams chat completions as SSE", async () => {
    const model = opencodeModel();
    const svc = makeService((_body, stream) => {
      expect(stream).toBe(true);
      return {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: streamFromString('data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"a"},"finish_reason":null}]}\n\ndata: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'),
      };
    });

    const result = await svc.handle(playgroundRequest("/v1/chat/completions", "POST", { model, stream: true, messages: [{ role: "user", content: "hi" }] }), svc.chatCompletionsConfig());
    expect(result.status).toBe(200);
    const text = typeof result.body === "string" ? result.body : await readAllText(result.body);
    expect(text).toContain('data: {"id":"x"');
    expect(text).toContain("data: [DONE]");
  });

  it("rejects invalid playground auth", async () => {
    const model = opencodeModel();
    const svc = makeService(() => jsonResponse(200, {}));
    const request = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "X-Opendum-Playground-User-Id": "u", "X-Opendum-Playground-Timestamp": "1", "X-Opendum-Playground-Signature": "deadbeef", "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [] }),
    });
    const result = await svc.handle(request, svc.chatCompletionsConfig());
    expect(result.status).toBe(401);
    const text = typeof result.body === "string" ? result.body : await readAllText(result.body);
    expect(JSON.parse(text)).toMatchObject({ error: { message: "Invalid playground session", type: "authentication_error" } });
  });

  it("rejects missing model param", async () => {
    const svc = makeService(() => jsonResponse(200, {}));
    const result = await svc.handle(playgroundRequest("/v1/chat/completions", "POST", { messages: [] }), svc.chatCompletionsConfig());
    expect(result.status).toBe(400);
    const text = typeof result.body === "string" ? result.body : await readAllText(result.body);
    expect(JSON.parse(text)).toMatchObject({ error: { message: "model is required" } });
  });

  it("anthropic messages endpoint formats errors as anthropic", async () => {
    const svc = makeService(() => jsonResponse(200, {}));
    const result = await svc.handle(playgroundRequest("/v1/messages", "POST", {}), svc.messagesAdapter());
    expect(result.status).toBe(400);
    const text = typeof result.body === "string" ? result.body : await readAllText(result.body);
    expect(JSON.parse(text)).toMatchObject({ type: "error", error: { message: "model is required", type: "invalid_request_error" } });
  });

  it("provider account selector splits prefix/model", async () => {
    const svc = makeService(() => jsonResponse(200, {}));
    const [accountID, model, ok] = svc.modelAccountSelector("my-account/gpt-5");
    expect(ok).toBe(true);
    expect(accountID).toBe("my-account");
    expect(model).toBe("gpt-5");
    // known provider prefixes pass through
    const [, , known] = svc.modelAccountSelector("opencode/gpt-5");
    expect(known).toBe(false);
  });
});
