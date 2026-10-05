import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  encodeQuery,
  getQuotaJson,
  putQuotaCache,
  quotaFetchFor,
} from "#quota/lib/cache.ts";
import type { QuotaAccount, QuotaContext } from "#quota/types.ts";

type Stored = { value: string; ttl: number };

function fakeJournal(options: { get?: (key: string) => Promise<string | null>; setThrows?: boolean } = {}): {
  journal: NonNullable<QuotaContext["journal"]>;
  stored: Map<string, Stored>;
} {
  const stored = new Map<string, Stored>();
  const journal = {
    get: options.get ?? (async (key: string) => stored.get(key)?.value ?? null),
    set: async (key: string, value: string, ttl: number) => {
      if (options.setThrows) throw new Error("redis down");
      stored.set(key, { value, ttl });
    },
  } as unknown as NonNullable<QuotaContext["journal"]>;
  return { journal, stored };
}

function context(fetchFn: QuotaContext["fetch"], journal: QuotaContext["journal"] = null): QuotaContext {
  return { fetch: fetchFn, journal } as unknown as QuotaContext;
}

function account(): QuotaAccount {
  return { id: "a1", provider: "hyper", accountId: null, projectId: null } as unknown as QuotaAccount;
}

describe("getQuotaJson", () => {
  it("performs a live request and returns the cache key", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const result = await getQuotaJson(
      context(async (url, init) => {
        calls.push({ url, init });
        return new Response("body", { status: 200, headers: { "x-codex-primary-used-percent": "10" } });
      }),
      account(),
      false,
      "codex:usage",
      "post",
      "https://api/usage",
      { Authorization: "Bearer t" },
      { a: 1 }
    );
    assert.equal(result.statusCode, 200);
    assert.equal(result.raw, "body");
    assert.equal(result.fromCache, false);
    assert.equal(calls[0]!.url, "https://api/usage");
    assert.equal(calls[0]!.init!.method, "post");
    assert.equal(calls[0]!.init!.body, JSON.stringify({ a: 1 }));
  });

  it("returns cached entries with restored headers", async () => {
    const body = Buffer.from("cached-body", "utf8").toString("base64");
    const { journal } = fakeJournal({
      get: async () =>
        JSON.stringify({ statusCode: 200, header: { "x-codex-primary-used-percent": ["42"] }, body }),
    });
    const result = await getQuotaJson(context(async () => new Response("live"), journal), account(), false, "n", "GET", "u", {}, null);
    assert.equal(result.fromCache, true);
    assert.equal(result.raw, "cached-body");
    assert.equal(result.header.get("x-codex-primary-used-percent"), "42");
  });

  it("skips cache when forced, empty, or corrupt", async () => {
    const { journal } = fakeJournal({ get: async () => JSON.stringify({ statusCode: 0, body: "" }) });
    const live = await getQuotaJson(context(async () => new Response("live"), journal), account(), false, "n", "GET", "u", {}, null);
    assert.equal(live.fromCache, false);
    assert.equal(live.raw, "live");

    const throwing = fakeJournal({ get: async () => { throw new Error("bad"); } }).journal;
    const recovered = await getQuotaJson(context(async () => new Response("live"), throwing), account(), false, "n", "GET", "u", {}, null);
    assert.equal(recovered.fromCache, false);

    const corrupt = fakeJournal({ get: async () => "not json" }).journal;
    const parsed = await getQuotaJson(context(async () => new Response("live"), corrupt), account(), false, "n", "GET", "u", {}, null);
    assert.equal(parsed.fromCache, false);

    const forced = await getQuotaJson(context(async () => new Response("live"), journal), account(), true, "n", "GET", "u", {}, null);
    assert.equal(forced.fromCache, false);
  });
});

describe("putQuotaCache", () => {
  it("stores successful responses", async () => {
    const { journal, stored } = fakeJournal();
    await putQuotaCache(context(async () => new Response(""), journal), {
      statusCode: 200,
      header: new Headers({ "x-codex-primary-used-percent": "10" }),
      raw: "body",
      cacheKey: "key",
      fromCache: false,
    });
    assert.equal(stored.size, 1);
    const entry = JSON.parse([...stored.values()][0]!.value) as { statusCode: number; body: string; header: Record<string, string[]> };
    assert.equal(entry.statusCode, 200);
    assert.equal(Buffer.from(entry.body, "base64").toString("utf8"), "body");
    assert.deepEqual(entry.header["x-codex-primary-used-percent"], ["10"]);
  });

  it("skips stores for missing journals, cache hits, bad keys and errors", async () => {
    const result = { statusCode: 200, header: new Headers(), raw: "body", cacheKey: "key", fromCache: false };
    await putQuotaCache(context(async () => new Response("")), result);

    const { journal, stored } = fakeJournal();
    await putQuotaCache(context(async () => new Response(""), journal), { ...result, fromCache: true });
    await putQuotaCache(context(async () => new Response(""), journal), { ...result, cacheKey: "" });
    await putQuotaCache(context(async () => new Response(""), journal), { ...result, statusCode: 500 });
    assert.equal(stored.size, 0);

    const throwing = fakeJournal({ setThrows: true }).journal;
    await putQuotaCache(context(async () => new Response(""), throwing), result);
  });
});

describe("cache helpers", () => {
  it("encodes queries", () => {
    assert.equal(encodeQuery("https://x", new URLSearchParams()), "https://x");
    assert.equal(encodeQuery("https://x", new URLSearchParams({ a: "1" })), "https://x?a=1");
  });

  it("exposes the context fetch", () => {
    const fetchFn = async () => new Response("x");
    assert.equal(quotaFetchFor(context(fetchFn)), fetchFn);
  });
});
