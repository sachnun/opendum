import { describe, expect, it } from "bun:test";
import { Effect, Exit } from "effect";

import { FallbackPolicy, NoFallbackState, RedisFallbackRouter } from "./fallback.js";
import { ProviderFallbackFailure } from "./errors.js";
import { RequestFailure, Retry } from "./http.js";

describe("fallback router", () => {
  it("keeps a best effort sticky check failure on the success channel", async () => {
    const router = new RedisFallbackRouter({
      exists: async () => {
        throw new Error("redis down");
      },
    } as never);
    const sticky = await Effect.runPromise(router.sticky("openrouter"));
    expect(sticky).toBe(false);
  });

  it("swallows strike and clear failures", async () => {
    const router = new RedisFallbackRouter({
      incr: async () => {
        throw new Error("redis down");
      },
      del: async () => {
        throw new Error("redis down");
      },
    } as never);
    await Effect.runPromise(router.recordStrike("openrouter"));
    await Effect.runPromise(router.clear("openrouter"));
  });

  it("falls back to the secondary endpoint on a 429", async () => {
    const calls: string[] = [];
    const response = await Effect.runPromise(
      new FallbackPolicy(new NoFallbackState()).post("openrouter", "primary", "fallback", (url) =>
        Effect.sync(() => {
          calls.push(url);
          return new Response(null, { status: url === "primary" ? 429 : 200 });
        })
      )
    );
    expect(calls).toEqual(["primary", "fallback"]);
    expect(response.status).toBe(200);
  });

  it("uses the primary endpoint without a fallback url", async () => {
    const calls: string[] = [];
    await Effect.runPromise(
      new FallbackPolicy(null).post("openrouter", "primary", "", (url) =>
        Effect.sync(() => {
          calls.push(url);
          return new Response(null, { status: 200 });
        })
      )
    );
    expect(calls).toEqual(["primary"]);
  });
});

describe("provider resilience helpers", () => {
  it("normalizes any failure into a ProviderRequestFailure", async () => {
    const exit = await Effect.runPromiseExit(
      RequestFailure.normalize("openrouter", Effect.fail(new Error("boom")))
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const failure = Exit.findErrorOption(exit);
    if (failure._tag === "Some") {
      expect(failure.value._tag).toBe("ProviderRequestFailure");
      expect(failure.value.provider).toBe("openrouter");
      expect(failure.value.message).toBe("boom");
    }
  });

  it("wraps a transport failure with the provider and url", () => {
    const failure = RequestFailure.transport("codex", new Error("dns"), "https://example.test");
    expect(failure._tag).toBe("ProviderTransportFailure");
    expect(failure.url).toBe("https://example.test");
    expect(failure.message).toBe("dns");
  });

  it("only treats 403 and 429 as fallback triggers", () => {
    expect(FallbackPolicy.triggers(403)).toBe(true);
    expect(FallbackPolicy.triggers(429)).toBe(true);
    expect(FallbackPolicy.triggers(500)).toBe(false);
  });

  it("retryTransient evaluates the source once when attempts is one", async () => {
    let calls = 0;
    await Effect.runPromise(
      Retry.transient(
        Effect.suspend(() => {
          calls += 1;
          return Effect.fail(new ProviderFallbackFailure({ message: "nope", provider: "x" }));
        }),
        { attempts: 1, baseDelayMs: 1 }
      ).pipe(Effect.ignore)
    );
    expect(calls).toBe(1);
  });

  it("reports a status for null responses", () => {
    expect(RequestFailure.status(null)).toBe(0);
    expect(RequestFailure.status(new Response(null, { status: 204 }))).toBe(204);
  });
});
