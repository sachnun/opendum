import { describe, expect, it } from "vitest";
import { InternalRelay } from "../src/internal.js";
import { validateInternalSignature } from "../src/errors.js";
import type { HttpClient, UpstreamResponse } from "../src/providers/types.js";
import { streamFromString } from "../src/providers/http.js";

const SECRET = "test-secret";

function signRequest(path: string, body: string, secret = SECRET): Request {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const { createHmac } = require("node:crypto") as typeof import("node:crypto");
  const mac = createHmac("sha256", secret);
  mac.update(timestamp).update("\n").update(path).update("\n").update(body);
  return new Request("http://localhost" + path, {
    method: "POST",
    headers: {
      "X-Opendum-Internal-Timestamp": timestamp,
      "X-Opendum-Internal-Signature": mac.digest("hex"),
    },
    body,
  });
}

class StubClient implements HttpClient {
  captured: Array<{ url: string; method: string; headers: Record<string, string>; body: string | undefined }> = [];
  response: UpstreamResponse = { status: 200, headers: { "content-type": "application/json" }, body: streamFromString(`{"ok":true}`) };

  async fetch(url: string, init: { method: string; headers: Record<string, string>; body?: string | Uint8Array | null }): Promise<UpstreamResponse> {
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers)) lower[k.toLowerCase()] = v;
    this.captured.push({ url, method: init.method, headers: lower, body: typeof init.body === "string" ? init.body : undefined });
    return this.response;
  }
}

function relay(client: StubClient) {
  return new InternalRelay(client, SECRET, (request, path, body) => validateInternalSignature(SECRET, request, path, body));
}

describe("internal relay (ported from internal_test.go)", () => {
  it("forwards allowed URL with header sanitization", async () => {
    const client = new StubClient();
    client.response = {
      status: 200,
      headers: { "content-type": "application/json", "x-codex-primary-used-percent": "12" },
      body: streamFromString(`{"ok":true}`),
    };
    const result = await relay(client).handle(signRequest("/internal/refresh", `{"url":"https://openrouter.ai/api/v1/models","method":"GET","headers":{"Authorization":"Bearer token","Connection":"keep-alive"}}`), "/internal/refresh");

    expect(result.status).toBe(200);
    expect(client.captured).toHaveLength(1);
    expect(client.captured[0]!.method).toBe("GET");
    expect(client.captured[0]!.url).toBe("https://openrouter.ai/api/v1/models");
    expect(client.captured[0]!.headers["authorization"]).toBe("Bearer token");
    expect(client.captured[0]!.headers["connection"]).toBeUndefined();
    expect(result.headers["x-codex-primary-used-percent"]).toBe("12");
    expect(typeof result.body === "string" ? result.body : await readBodyText(result.body)).toBe(`{"ok":true}`);
  });

  it("forwards qoder validation request", async () => {
    const client = new StubClient();
    client.response = { status: 200, headers: { "content-type": "application/json" }, body: streamFromString(`{"object":"list","data":[]}`) };
    const result = await relay(client).handle(signRequest("/internal/refresh", `{"url":"https://openapi.qoder.sh/api/v1/models","method":"GET","headers":{"Authorization":"Bearer qod_pat_test","Accept":"application/json"}}`), "/internal/refresh");

    expect(result.status).toBe(200);
    expect(result.headers["x-opendum-internal-relay-error"]).toBeUndefined();
    expect(client.captured[0]!.method).toBe("GET");
    expect(client.captured[0]!.url).toBe("https://openapi.qoder.sh/api/v1/models");
    expect(client.captured[0]!.headers["authorization"]).toBe("Bearer qod_pat_test");
  });

  it("rejects http url", async () => {
    const client = new StubClient();
    const result = await relay(client).handle(signRequest("/internal/refresh", `{"url":"http://openrouter.ai/api/v1/models","method":"GET"}`), "/internal/refresh");
    expect(result.status).toBe(400);
  });

  it("rejects userinfo url", async () => {
    const client = new StubClient();
    const result = await relay(client).handle(signRequest("/internal/refresh", `{"url":"https://token@openrouter.ai/api/v1/models","method":"GET"}`), "/internal/refresh");
    expect(result.status).toBe(400);
  });

  it("forwards post body", async () => {
    const client = new StubClient();
    client.response = { status: 202, headers: { "content-type": "application/json" }, body: streamFromString(`{"accepted":true}`) };
    const body = `{"url":"https://integrate.api.nvidia.com/v1/chat/completions","method":"POST","headers":{"Authorization":"Bearer token","Content-Type":"application/json"},"body":{"model":"unit","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}}`;
    const result = await relay(client).handle(signRequest("/internal/refresh", body), "/internal/refresh");
    expect(result.status).toBe(202);
    expect(client.captured[0]!.body).toContain(`"model":"unit"`);
  });

  it("forwards kiro token exchange with string body", async () => {
    const client = new StubClient();
    client.response = { status: 200, headers: { "content-type": "application/json" }, body: streamFromString(`{"accessToken":"access","refreshToken":"refresh","expiresIn":3600}`) };
    const body = `{"url":"https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token","method":"POST","headers":{"Content-Type":"application/json","Accept":"application/json","User-Agent":"KiroIDE"},"body":"{\\"code\\":\\"abc\\",\\"code_verifier\\":\\"verifier\\",\\"redirect_uri\\":\\"http://localhost:49153/oauth/callback\\"}"}`;
    const result = await relay(client).handle(signRequest("/internal/refresh", body), "/internal/refresh");
    expect(result.status).toBe(200);
    expect(client.captured[0]!.headers["user-agent"]).toBe("KiroIDE");
    expect(client.captured[0]!.body).toBe(`{"code":"abc","code_verifier":"verifier","redirect_uri":"http://localhost:49153/oauth/callback"}`);
  });

  it("rejects invalid signature", async () => {
    const client = new StubClient();
    const request = new Request("http://localhost/internal/refresh", { method: "POST", headers: { "X-Opendum-Internal-Timestamp": "1", "X-Opendum-Internal-Signature": "deadbeef" }, body: "{}" });
    const result = await relay(client).handle(request, "/internal/refresh");
    expect(result.status).toBe(401);
    expect(client.captured).toHaveLength(0);
  });
});

async function readBodyText(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  return out;
}
