import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { Registry } from "@opendum/models/runtime";
import { OpencodeProvider } from "./opencode.js";
import type { UpstreamTransport } from "../core/http.js";
import type { ProviderRequest } from "../types.js";

const SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const REQUEST_PATTERN = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function capture(model: string, body: Record<string, unknown>, streaming = true): Promise<Captured> {
  let captured: Captured | null = null;
  const direct = async (url: string, init?: RequestInit): Promise<Response> => {
    captured = {
      url,
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    };
    return new Response("data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const registry = {
    upstream: (name: string) => name,
    config: () => null,
  } as unknown as Registry;
  const transport: UpstreamTransport = { direct, egress: null, egressReady: () => false };
  const provider = new OpencodeProvider({ registry, transport, fallback: null });
  const request = { body, stream: streaming } as ProviderRequest;
  return Effect.runPromise(provider.makeRequest(request) as Effect.Effect<Response, never>).then(() => {
    if (!captured) throw new Error("no request captured");
    return captured;
  });
}

function tool(name: string, properties: Record<string, unknown> = { x: { type: "string" } }) {
  return { type: "function", function: { name, description: "d", parameters: { type: "object", properties } } };
}

function toolNames(body: Record<string, unknown>): string[] {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return tools.map((raw) => {
    const entry = raw as { name?: string; function?: { name?: string } };
    return entry.function?.name ?? entry.name ?? "";
  });
}

describe("opencode free tier request contract", () => {
  it("streams every request and injects the read fingerprint tool when none is declared", async () => {
    const captured = await capture("big-pickle", { model: "big-pickle", messages: [{ role: "user", content: "hi" }] });
    expect(captured.body.stream).toBe(true);
    expect(toolNames(captured.body)).toContain("read");
  });

  it("adds read alongside a single unrelated tool", async () => {
    const captured = await capture("big-pickle", {
      model: "big-pickle",
      messages: [{ role: "user", content: "hi" }],
      tools: [tool("bash")],
    });
    expect(toolNames(captured.body)).toEqual(["read", "bash"]);
  });

  it("repairs a read tool whose parameter object is empty", async () => {
    const captured = await capture("big-pickle", {
      model: "big-pickle",
      messages: [{ role: "user", content: "hi" }],
      tools: [tool("read", {})],
    });
    const read = (captured.body.tools as Array<{ function: { parameters: { properties: unknown } } }>)[0];
    expect(Object.keys(read.function.parameters.properties as Record<string, unknown>).length).toBeGreaterThan(0);
  });

  it("leaves a valid client tool list untouched", async () => {
    const captured = await capture("big-pickle", {
      model: "big-pickle",
      messages: [{ role: "user", content: "hi" }],
      tools: [tool("read"), tool("bash"), tool("glob")],
    });
    expect(toolNames(captured.body)).toEqual(["read", "bash", "glob"]);
  });

  it("sends the session header the upstream validates, in both spellings", async () => {
    const captured = await capture("big-pickle", { model: "big-pickle", messages: [{ role: "user", content: "hi" }] });
    const session = captured.headers["X-Opencode-Session"];
    expect(session).toMatch(SESSION_PATTERN);
    expect(captured.headers["X-Opencode-Session-Id"]).toBe(session);
    expect(Number.parseInt(session.slice(13, 16), 16)).toBeGreaterThanOrEqual(0xfc0);
    expect(captured.headers["X-Opencode-Request"]).toMatch(REQUEST_PATTERN);
    expect(captured.headers["User-Agent"]).toBe("opencode/1.19.0");
  });

  it("derives a deterministic session from a client seed", async () => {
    const first = await capture("big-pickle", {
      model: "big-pickle",
      messages: [{ role: "user", content: "hi" }],
      _sessionId: "conv-42",
    });
    const second = await capture("big-pickle", {
      model: "big-pickle",
      messages: [{ role: "user", content: "hi" }],
      _sessionId: "conv-42",
    });
    const other = await capture("big-pickle", {
      model: "big-pickle",
      messages: [{ role: "user", content: "hi" }],
      _sessionId: "conv-43",
    });
    expect(first.headers["X-Opencode-Session"]).toBe(second.headers["X-Opencode-Session"]);
    expect(first.headers["X-Opencode-Session"]).not.toBe(other.headers["X-Opencode-Session"]);
  });

  it("keeps a client session already in the canonical shape", async () => {
    const canonical = "ses_012345678fc0ABCDEFGHIJKLMN";
    const captured = await capture("big-pickle", {
      model: "big-pickle",
      messages: [{ role: "user", content: "hi" }],
      _sessionId: canonical,
    });
    expect(captured.headers["X-Opencode-Session"]).toBe(canonical);
  });

  it("targets the inference surface the free tier accepts", async () => {
    const captured = await capture("big-pickle", { model: "big-pickle", messages: [{ role: "user", content: "hi" }] });
    expect(captured.url).toBe("https://opencode.ai/inference/v1/chat/completions");
  });
});
