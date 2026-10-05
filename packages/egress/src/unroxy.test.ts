import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_UNROXY_BASE_URL, UnroxyEgress } from "#egress/unroxy.ts";
import {
  PrivateHostError,
  assertPublicHost,
  createGuardedFetch,
  isPrivateHost,
  isPrivateIp,
} from "#egress/index.ts";

describe("UnroxyEgress", () => {
  it("normalizes base urls", () => {
    assert.equal(new UnroxyEgress().baseUrl, DEFAULT_UNROXY_BASE_URL);
    assert.equal(new UnroxyEgress({ baseUrl: "https://x.dev" }).baseUrl, "https://x.dev/");
    assert.equal(new UnroxyEgress({ baseUrl: "https://x.dev/" }).baseUrl, "https://x.dev/");
    assert.equal(new UnroxyEgress({ baseUrl: "   " }).baseUrl, DEFAULT_UNROXY_BASE_URL);
  });

  it("prefixes fetch targets and closes cleanly", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    try {
      const egress = new UnroxyEgress({ baseUrl: "https://proxy" });
      await egress.fetch("https://api.example/path", { method: "POST" });
      await egress.fetch(new URL("https://api.example/other"));
      assert.equal(calls[0]!.url, "https://proxy/https://api.example/path");
      assert.equal(calls[0]!.init!.method, "POST");
      assert.equal(calls[1]!.url, "https://proxy/https://api.example/other");
      await egress.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("egress index exports", () => {
  it("re-exports the ssrf helpers", () => {
    assert.equal(isPrivateIp("127.0.0.1"), true);
    assert.equal(isPrivateHost("localhost"), true);
    assert.throws(() => assertPublicHost("127.0.0.1"), PrivateHostError);
  });

  it("creates a guarded fetcher", async () => {
    const fetcher = createGuardedFetch();
    assert.equal(typeof fetcher.fetch, "function");
    await fetcher.close();
  });
});
