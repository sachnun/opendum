import { describe, expect, it, setSystemTime } from "bun:test";
import { Effect } from "effect";
import {
  QuotaRegistry,
  clampFraction,
  displayNumber,
  formatFloat,
  formatTimeUntilReset,
  isQuotaProvider,
  parseQuotaNumber,
  parseResetIso,
  quotaFallbackTier,
  quotaProvidersWithoutToken,
} from "./index.js";
import type { AccountQuotaInfo, QuotaContext, QuotaFetcher } from "./index.js";

describe("quota helpers", () => {
  it("clamps fractions", () => {
    expect(clampFraction(0.5)).toBe(0.5);
    expect(clampFraction(-1)).toBe(0);
    expect(clampFraction(2)).toBe(1);
  });

  it("formats numbers", () => {
    expect(displayNumber(42)).toBe(42);
    expect(displayNumber(42.129)).toBe(42.13);
    expect(formatFloat(42)).toBe("42");
    expect(formatFloat(42.5)).toBe("42.50");
  });

  it("parses quota numbers", () => {
    expect(parseQuotaNumber("12.5")).toBe(12.5);
    expect(parseQuotaNumber(7)).toBe(7);
    expect(parseQuotaNumber("nope")).toBe(null);
  });

  it("normalizes reset ISO values", () => {
    expect(parseResetIso("2026-01-01T00:00:00Z")).toBe("2026-01-01T00:00:00.000Z");
    expect(parseResetIso(1_700_000_000)).toBe("2023-11-14T22:13:20.000Z");
    expect(parseResetIso("not-a-date")).toBe(null);
  });

  it("formats time until reset", () => {
    setSystemTime(new Date(1_000_000));
    expect(formatTimeUntilReset(1_000_000 + 90 * 60 * 1000)).toBe("1h 30m");
    expect(formatTimeUntilReset(1_000_000 + 25 * 60 * 1000)).toBe("25m");
    setSystemTime();
    expect(formatTimeUntilReset(1)).toBe("resetting...");
    expect(formatTimeUntilReset(0)).toBe(null);
  });

  it("falls back to free tier", () => {
    expect(quotaFallbackTier({ id: "1", userId: "u", provider: "kiro", tier: "pro" })).toBe("pro");
    expect(quotaFallbackTier({ id: "1", userId: "u", provider: "kiro", tier: null })).toBe("free");
  });
});

function context(overrides: Partial<QuotaContext> = {}): QuotaContext {
  return {
    fetch: async () => new Response("{}"),
    journal: null,
    decrypt: (value) => value,
    getCredentials: async () => "token",
    ...overrides,
  };
}

function account(provider: string): { id: string; userId: string; provider: string } {
  return { id: "account-1", userId: "user-1", provider };
}

function okResult(): AccountQuotaInfo {
  return { status: "ok", error: "", groups: [] };
}

describe("quota registry", () => {
  it("knows which providers have quota fetchers", () => {
    expect(isQuotaProvider("kiro")).toBe(true);
    expect(isQuotaProvider("openrouter")).toBe(true);
    expect(isQuotaProvider("unknown-provider")).toBe(false);
  });

  it("reports providers that need no access token", () => {
    const providers = quotaProvidersWithoutToken();
    expect(providers.has("openrouter")).toBe(true);
    expect(providers.has("zenmux")).toBe(true);
    expect(providers.has("hyper")).toBe(true);
    expect(providers.has("kiro")).toBe(false);
  });

  it("exposes lookup helpers on custom registries", () => {
    const fetcher: QuotaFetcher = { provider: "custom", withoutToken: true, fetch: () => Effect.succeed(okResult()) };
    const registry = new QuotaRegistry([fetcher]);
    expect(registry.isSupported("custom")).toBe(true);
    expect(registry.isSupported("kiro")).toBe(false);
    expect([...registry.providersWithoutToken()]).toEqual(["custom"]);
  });

  it("returns an error result for unsupported providers", async () => {
    const registry = new QuotaRegistry([]);
    const result = await Effect.runPromise(registry.fetch(context(), account("missing"), false));
    expect(result.status).toBe("error");
    expect(result.groups).toEqual([]);
  });

  it("passes an empty token to token-less fetchers", async () => {
    const seen: { token: string | null } = { token: null };
    const fetcher: QuotaFetcher = {
      provider: "tokenless",
      withoutToken: true,
      fetch: (_ctx, _account, accessToken) => {
        seen.token = accessToken;
        return Effect.succeed(okResult());
      },
    };
    const registry = new QuotaRegistry([fetcher]);
    const result = await Effect.runPromise(registry.fetch(context(), account("tokenless"), false));
    expect(result.status).toBe("ok");
    expect(seen.token).toBe("");
  });

  it("resolves credentials for token providers", async () => {
    const seen: { token: string | null } = { token: null };
    const fetcher: QuotaFetcher = {
      provider: "tokened",
      withoutToken: false,
      fetch: (_ctx, _account, accessToken) => {
        seen.token = accessToken;
        return Effect.succeed(okResult());
      },
    };
    const registry = new QuotaRegistry([fetcher]);
    const result = await Effect.runPromise(
      registry.fetch(context({ getCredentials: async () => "secret" }), account("tokened"), false)
    );
    expect(result.status).toBe("ok");
    expect(seen.token).toBe("secret");
  });

  it("reports expired credentials as an expired quota status", async () => {
    let fetched = false;
    const fetcher: QuotaFetcher = {
      provider: "tokened",
      withoutToken: false,
      fetch: () => {
        fetched = true;
        return Effect.succeed(okResult());
      },
    };
    const registry = new QuotaRegistry([fetcher]);
    const result = await Effect.runPromise(
      registry.fetch(
        context({
          getCredentials: async () => {
            throw new Error("token missing");
          },
        }),
        account("tokened"),
        false
      )
    );
    expect(result.status).toBe("expired");
    expect(fetched).toBe(false);
  });
});
