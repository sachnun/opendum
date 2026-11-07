import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { Registry } from "@opendum/models/runtime";
import { DeepAIProvider } from "@opendum/providers/upstreams/deepai/index";
import type { UpstreamTransport } from "@opendum/providers/core/http";
import type { ProviderRequest } from "@opendum/providers/types";

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function registry(config: Record<string, unknown> | null = null): Registry {
  return {
    upstream: (name: string) => name,
    config: () => config,
  } as unknown as Registry;
}

function capture(
  body: Record<string, unknown>,
  options: { config?: Record<string, unknown> | null; stream?: boolean } = {}
): Promise<Captured> {
  let captured: Captured | null = null;
  const direct = async (url: string, init?: RequestInit): Promise<Response> => {
    captured = {
      url,
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    };
    return new Response("data: [DONE]\n\n", { status: 200 });
  };
  const transport: UpstreamTransport = { direct, egress: null, egressReady: () => false };
  const provider = new DeepAIProvider({
    registry: registry(options.config ?? null),
    transport,
    fallback: null,
  });
  const request = { body, stream: options.stream ?? true, credentials: " key-1 " } as unknown as ProviderRequest;
  return Effect.runPromise(provider.makeRequest(request) as Effect.Effect<Response, never>).then(() => {
    if (!captured) return { url: "", headers: {}, body: {} };
    return captured;
  });
}

describe("DeepAI request contract", () => {
  it("sends the api-key and lane headers instead of a bearer token", async () => {
    const captured = await capture({ model: "glm-5.3-flash", messages: [{ role: "system", content: "s" }] });
    expect(captured.url).toBe("https://api.deepai.org/deepai_code/chat/completions");
    expect(captured.headers["api-key"]).toBe("key-1");
    expect(captured.headers["X-DeepAI-Code-Theos"]).toBe("4");
    expect(captured.headers["X-DeepAI-Code-Instance"]).toMatch(/^[0-9a-f]{32}$/);
    expect(captured.headers["X-DeepAI-Code-Machine"]).toMatch(/^[0-9a-f]{64}$/);
    expect(captured.headers.Authorization).toBeUndefined();
  });

  it("prepends a system message when the conversation starts with a user turn", async () => {
    const captured = await capture({ model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }] });
    const messages = captured.body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toBe("You are a helpful assistant.");
    expect(messages[1]?.role).toBe("user");
  });

  it("keeps an existing developer message as the first turn", async () => {
    const captured = await capture({ model: "glm-5.3-flash", messages: [{ role: "developer", content: "s" }] });
    const messages = captured.body.messages as Array<{ role: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("developer");
  });

  it("rewrites typed text parts and enables stream usage", async () => {
    const captured = await capture({
      model: "glm-5.3-flash",
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
    });
    const messages = captured.body.messages as Array<{ content: unknown }>;
    expect(messages[1]?.content).toEqual([{ type: "text", text: "hi" }]);
    expect(captured.body.stream).toBe(true);
    expect(captured.body.stream_options).toEqual({ include_usage: true });
  });

  it("drops unsupported parameters", async () => {
    const captured = await capture({
      model: "glm-5.3-flash",
      messages: [{ role: "system", content: "s" }],
      store: false,
      _includeReasoning: true,
    });
    expect(captured.body.store).toBeUndefined();
    expect(captured.body._includeReasoning).toBeUndefined();
    expect(captured.body.model).toBe("glm-5.3-flash");
  });

  it("uses the responses surface for models flagged with responses_api", async () => {
    const captured = await capture(
      {
        model: "gpt-6-astra",
        messages: [
          { role: "system", content: "s" },
          { role: "user", content: "hi" },
        ],
        max_tokens: 256,
      },
      { config: { responses_api: true } }
    );
    expect(captured.url).toBe("https://api.deepai.org/deepai_code/responses");
    expect(captured.body.max_output_tokens).toBe(256);
    expect(captured.body.prompt_cache_key).toBeUndefined();
    const input = captured.body.input as Array<{ role: string }>;
    expect(input[0]?.role).toBe("developer");
  });

  it("retries a session_busy refusal before returning it", async () => {
    const seen: number[] = [];
    const direct = async (): Promise<Response> => {
      seen.push(seen.length + 1);
      const status = seen.length === 1 ? 409 : 200;
      const body = status === 409 ? JSON.stringify({ error: { code: "session_busy" } }) : "data: [DONE]\n\n";
      return new Response(body, { status, headers: { "retry-after": "0.001" } });
    };
    const transport: UpstreamTransport = { direct, egress: null, egressReady: () => false };
    const provider = new DeepAIProvider({ registry: registry(), transport, fallback: null });
    const request = {
      body: { model: "glm-5.3", messages: [{ role: "system", content: "s" }] },
      stream: true,
      credentials: "key-1",
    } as unknown as ProviderRequest;
    const resp = await Effect.runPromise(provider.makeRequest(request) as Effect.Effect<Response, never>);
    expect(resp.status).toBe(200);
    expect(seen).toHaveLength(2);
  });
});
