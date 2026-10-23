import { describe, expect, it } from "bun:test";

import { extractSessionId } from "../core/service-helpers.js";

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://proxy.test/v1/chat/completions", { method: "POST", headers });
}

describe("extractSessionId", () => {
  it("prefers an explicit session header", () => {
    expect(extractSessionId(request({ "x-session-id": "sess-1" }), {})).toBe("sess-1");
    expect(extractSessionId(request({ "x-session-affinity": "sess-2" }), {})).toBe("sess-2");
  });

  it("ignores a per request client id so retries keep the same session", () => {
    const first = extractSessionId(request({ "x-client-request-id": "req-a" }), { messages: [] });
    const second = extractSessionId(request({ "x-client-request-id": "req-b" }), { messages: [] });

    expect(first).toBe(second);
    expect(first).toBe("");
  });

  it("still reads a session id from the body", () => {
    expect(extractSessionId(request(), { prompt_cache_key: "cache-1" })).toBe("cache-1");
    expect(extractSessionId(request(), { conversation_id: "conv-1" })).toBe("conv-1");
  });

  it("derives a stable session from the first user turn", () => {
    const body = { messages: [{ role: "user", content: "please refactor this module for me" }] };

    const first = extractSessionId(request(), body);
    const second = extractSessionId(request(), body);

    expect(first).toBe(second);
    expect(first.startsWith("prompt:")).toBe(true);
  });
});
