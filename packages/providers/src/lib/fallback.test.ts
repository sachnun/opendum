import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NoFallbackState,
  RedisFallbackRouter,
  fallbackStickyKey,
  fallbackStrikeKey,
  postWithFallback,
  shouldUseFallbackEndpoint,
  type FallbackState,
} from "#providers/lib/fallback.ts";
import type { OpendumRedis } from "@opendum/redis";

type Call = { method: string; args: unknown[] };

function fakeRedis(script: Record<string, unknown> = {}): { redis: OpendumRedis; calls: Call[] } {
  const calls: Call[] = [];
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_target, prop: string) {
      return async (...args: unknown[]) => {
        calls.push({ method: prop, args });
        if (prop in script) {
          const value = script[prop];
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown)(...args) : value;
        }
        return 0;
      };
    },
  };
  const redis = new Proxy({}, handler) as unknown as OpendumRedis;
  return { redis, calls };
}

function ok(): Response {
  return new Response("ok", { status: 200 });
}

describe("fallback keys", () => {
  it("namespaces provider keys", () => {
    assert.equal(fallbackStickyKey("kiro"), "opendum:provider:fallback:kiro");
    assert.equal(fallbackStrikeKey("kiro"), "opendum:provider:fallback-strikes:kiro");
  });
});

describe("shouldUseFallbackEndpoint", () => {
  it("only treats 403 and 429 as fallbacks", () => {
    assert.equal(shouldUseFallbackEndpoint(403), true);
    assert.equal(shouldUseFallbackEndpoint(429), true);
    assert.equal(shouldUseFallbackEndpoint(200), false);
    assert.equal(shouldUseFallbackEndpoint(500), false);
  });
});

describe("NoFallbackState", () => {
  it("is a no-op", async () => {
    const state = new NoFallbackState();
    assert.equal(await state.sticky(), false);
    assert.equal(await state.recordStrike(), undefined);
    assert.equal(await state.clear(), undefined);
  });
});

describe("RedisFallbackRouter", () => {
  it("reads sticky flags and swallows redis errors", async () => {
    const { redis } = fakeRedis({ exists: 1 });
    assert.equal(await new RedisFallbackRouter(redis).sticky("kiro"), true);
    const { redis: zeroRedis } = fakeRedis({ exists: 0 });
    assert.equal(await new RedisFallbackRouter(zeroRedis).sticky("kiro"), false);
    const { redis: broken } = fakeRedis({ exists: () => Promise.reject(new Error("down")) });
    assert.equal(await new RedisFallbackRouter(broken).sticky("kiro"), false);
    assert.equal(await new RedisFallbackRouter(zeroRedis).sticky(""), false);
  });

  it("records strikes with expiry and escalation", async () => {
    let count = 0;
    const { redis, calls } = fakeRedis({ incr: () => Promise.resolve((count += 1)) });
    const router = new RedisFallbackRouter(redis);

    await router.recordStrike("kiro");
    await router.recordStrike("kiro");
    await router.recordStrike("kiro");

    assert.deepEqual(
      calls.map((call) => call.method),
      ["incr", "expire", "incr", "set", "del", "incr", "set", "del"]
    );
    await router.recordStrike("");
  });

  it("clears both keys and swallows errors", async () => {
    const { redis, calls } = fakeRedis();
    await new RedisFallbackRouter(redis).clear("kiro");
    assert.equal(calls[0]!.method, "del");
    assert.deepEqual(calls[0]!.args[0], [fallbackStickyKey("kiro"), fallbackStrikeKey("kiro")]);

    const { redis: broken } = fakeRedis({ del: () => Promise.reject(new Error("down")) });
    await new RedisFallbackRouter(broken).clear("kiro");
  });
});

describe("postWithFallback", () => {
  const provider = "kiro";
  const primaryUrl = "https://primary";
  const fallbackUrl = "https://fallback";

  it("uses the primary when no fallback is configured", async () => {
    const urls: string[] = [];
    await postWithFallback(null, provider, primaryUrl, "", async (url) => {
      urls.push(url);
      return ok();
    });
    assert.deepEqual(urls, [primaryUrl]);
  });

  it("returns a successful primary and clears state", async () => {
    const cleared: string[] = [];
    const state: FallbackState = {
      sticky: async () => false,
      recordStrike: async () => undefined,
      clear: async (value) => {
        cleared.push(value);
      },
    };
    const resp = await postWithFallback(state, provider, primaryUrl, fallbackUrl, async () => ok());
    assert.equal(resp.status, 200);
    assert.deepEqual(cleared, [provider]);
  });

  it("falls back and records a strike", async () => {
    const strikes: string[] = [];
    const state: FallbackState = {
      sticky: async () => false,
      recordStrike: async (value) => {
        strikes.push(value);
      },
      clear: async () => undefined,
    };
    const urls: string[] = [];
    const resp = await postWithFallback(state, provider, primaryUrl, fallbackUrl, async (url) => {
      urls.push(url);
      return new Response(null, { status: url === primaryUrl ? 429 : 200 });
    });
    assert.equal(resp.status, 200);
    assert.deepEqual(urls, [primaryUrl, fallbackUrl]);
    assert.deepEqual(strikes, [provider]);
  });

  it("prefers the fallback when sticky and reverts on failure", async () => {
    const state: FallbackState = {
      sticky: async () => true,
      recordStrike: async () => undefined,
      clear: async () => undefined,
    };
    const urls: string[] = [];
    const resp = await postWithFallback(state, provider, primaryUrl, fallbackUrl, async (url) => {
      urls.push(url);
      return new Response(null, { status: url === fallbackUrl ? 429 : 200 });
    });
    assert.equal(resp.status, 200);
    assert.deepEqual(urls, [fallbackUrl, primaryUrl]);
  });

  it("returns a successful sticky fallback directly", async () => {
    const state: FallbackState = {
      sticky: async () => true,
      recordStrike: async () => undefined,
      clear: async () => undefined,
    };
    const urls: string[] = [];
    await postWithFallback(state, provider, primaryUrl, fallbackUrl, async (url) => {
      urls.push(url);
      return ok();
    });
    assert.deepEqual(urls, [fallbackUrl]);
  });
});
