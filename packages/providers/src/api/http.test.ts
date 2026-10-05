import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createTransport,
  postExecuteWithFallback,
  postJSON,
  postJSONWithEgressFallback,
  postJSONWithHeaders,
  postJSONWithHeadersAuth,
  postJSONWithoutAuth,
  postWithEgressFallback,
  statusOf,
  type FetchLike,
} from "#providers/api/http.ts";
import type { FallbackState } from "#providers/lib/fallback.ts";

function ok(): Response {
  return new Response("ok", { status: 200 });
}

const okFetch: FetchLike = async () => ok();

function recorder(response: Response): { calls: Array<{ url: string; init?: RequestInit }>; fetch: FetchLike } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return response;
    },
  };
}

function state(sticky: boolean): { state: FallbackState; struck: string[]; cleared: string[] } {
  const struck: string[] = [];
  const cleared: string[] = [];
  return {
    struck,
    cleared,
    state: {
      sticky: async () => sticky,
      recordStrike: async (provider) => {
        struck.push(provider);
      },
      clear: async (provider) => {
        cleared.push(provider);
      },
    },
  };
}

describe("createTransport", () => {
  it("tracks egress readiness", () => {
    const transport = createTransport(okFetch);
    assert.equal(transport.egress, null);
    assert.equal(transport.egressReady(), false);
    const egress: FetchLike = okFetch;
    transport.setEgress(egress, true);
    assert.equal(transport.egress, egress);
    assert.equal(transport.egressReady(), true);
    transport.setEgress(egress, false);
    assert.equal(transport.egressReady(), false);
  });
});

describe("JSON posters", () => {
  it("builds auth headers and notifies start", async () => {
    const { calls, fetch } = recorder(ok());
    let started = 0;
    await postJSONWithHeadersAuth(fetch, "https://x", " tok ", { a: 1 }, true, { "X-Extra": "1" }, true, () => {
      started += 1;
    });
    const headers = calls[0]!.init!.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer tok");
    assert.equal(headers.Accept, "text/event-stream");
    assert.equal(headers["X-Extra"], "1");
    assert.equal(calls[0]!.init!.body, JSON.stringify({ a: 1 }));
    assert.equal(started, 1);
  });

  it("omits auth when disabled", async () => {
    const { calls, fetch } = recorder(ok());
    await postJSONWithoutAuth(fetch, "https://x", { a: 1 }, false);
    const headers = calls[0]!.init!.headers as Record<string, string>;
    assert.equal("Authorization" in headers, false);
    assert.equal(headers.Accept, "application/json");
  });

  it("wraps postJSON and postJSONWithHeaders", async () => {
    const { fetch } = recorder(ok());
    assert.equal((await postJSON(fetch, "https://x", "t", {}, false)).status, 200);
    assert.equal((await postJSONWithHeaders(fetch, "https://x", "t", {}, false, { "X-H": "v" })).status, 200);
  });
});

describe("postExecuteWithFallback", () => {
  it("uses only the primary when no fallback URL exists", async () => {
    const urls: string[] = [];
    await postExecuteWithFallback(okFetch, null, "p", "primary", "", async (_fn, url) => {
      urls.push(url);
      return ok();
    });
    assert.deepEqual(urls, ["primary"]);
  });

  it("clears state on a successful primary", async () => {
    const { state: fb, cleared } = state(false);
    const resp = await postExecuteWithFallback(okFetch, fb, "p", "primary", "fallback", async () => ok());
    assert.equal(resp.status, 200);
    assert.deepEqual(cleared, ["p"]);
  });

  it("routes to the fallback after a fallback status", async () => {
    const { state: fb, struck } = state(false);
    const urls: string[] = [];
    const resp = await postExecuteWithFallback(okFetch, fb, "p", "primary", "fallback", async (_fn, url) => {
      urls.push(url);
      return new Response(null, { status: url === "primary" ? 429 : 200 });
    });
    assert.equal(resp.status, 200);
    assert.deepEqual(urls, ["primary", "fallback"]);
    assert.deepEqual(struck, ["p"]);
  });

  it("prefers sticky fallback and reverts on failure", async () => {
    const { state: fb } = state(true);
    const urls: string[] = [];
    const resp = await postExecuteWithFallback(okFetch, fb, "p", "primary", "fallback", async (_fn, url) => {
      urls.push(url);
      return new Response(null, { status: url === "fallback" ? 429 : 200 });
    });
    assert.equal(resp.status, 200);
    assert.deepEqual(urls, ["fallback", "primary"]);
  });
});

describe("postWithEgressFallback", () => {
  it("uses the direct transport when egress is unavailable", async () => {
    const direct = recorder(ok());
    const transport = createTransport(direct.fetch);
    const resp = await postWithEgressFallback({ transport, state: null, provider: "p", primary: "u", execute: (fn, url) => fn(url) });
    assert.equal(resp.status, 200);
    assert.deepEqual(direct.calls.map((call) => call.url), ["u"]);
  });

  it("escalates to egress after a direct fallback status", async () => {
    const direct = recorder(new Response(null, { status: 429 }));
    const egress = recorder(ok());
    const transport = createTransport(direct.fetch);
    transport.setEgress(egress.fetch, true);
    const { state: fb, struck } = state(false);
    const resp = await postWithEgressFallback({ transport, state: fb, provider: "p", primary: "u", execute: (fn, url) => fn(url) });
    assert.equal(resp.status, 200);
    assert.equal(direct.calls.length, 1);
    assert.equal(egress.calls.length, 1);
    assert.deepEqual(struck, ["p"]);
  });

  it("prefers egress when sticky and reverts to direct", async () => {
    const direct = recorder(ok());
    const egress = recorder(new Response(null, { status: 403 }));
    const transport = createTransport(direct.fetch);
    transport.setEgress(egress.fetch, true);
    const { state: fb } = state(true);
    const resp = await postWithEgressFallback({ transport, state: fb, provider: "p", primary: "u", execute: (fn, url) => fn(url) });
    assert.equal(resp.status, 200);
    assert.equal(direct.calls.length, 1);
    assert.ok(egress.calls.length > 0);
  });

  it("surfaces egress errors", async () => {
    const transport = createTransport(okFetch);
    transport.setEgress(async () => {
      throw new Error("boom");
    }, true);
    const { state: fb } = state(true);
    await assert.rejects(
      postWithEgressFallback({ transport, state: fb, provider: "p", primary: "u", execute: (fn, url) => fn(url) }),
      /boom/
    );
  });
});

describe("postJSONWithEgressFallback", () => {
  it("forwards headers through the direct path", async () => {
    const direct = recorder(ok());
    const transport = createTransport(direct.fetch);
    const resp = await postJSONWithEgressFallback(transport, null, "p", "https://x", "tok", { a: 1 }, false, { "X-Y": "1" });
    assert.equal(resp.status, 200);
    const headers = direct.calls[0]!.init!.headers as Record<string, string>;
    assert.equal(headers["X-Y"], "1");
    assert.equal(headers.Authorization, "Bearer tok");
  });
});

describe("statusOf", () => {
  it("defaults to zero", () => {
    assert.equal(statusOf(null), 0);
    assert.equal(statusOf(undefined), 0);
    assert.equal(statusOf(new Response(null, { status: 204 })), 204);
  });
});
