import { describe, expect, it } from "vitest";
import { prioritizeAccounts, paidFirst, isPaidAccountTier, effectiveUnhealthyCount, successRecoveryCount, cooldownRecoveryCount, modelHealthStatus } from "../src/core/load-balancer.js";
import { preferSticky } from "../src/session/index.js";
import type { ProviderAccount } from "../src/db/index.js";
import { quotaRawCacheKey, quotaCacheHeaders, quotaRawCacheTTL } from "../src/core/quota/quota.js";
import { antigravityGroups, codexWindowGroup } from "../src/core/quota/quota-fetchers.js";
import { accountNeedsCredentialRefresh, tokenRefreshLockKey } from "../src/core/token-refresher.js";
import { encrypt } from "../src/crypto/index.js";
import type { Provider, ProviderAccountLike } from "../src/providers/types.js";

function account(id: string, provider: string, tier: string | null): ProviderAccount {
  return {
    id, userId: "", provider, name: id, accessToken: "", refreshToken: "", expiresAt: new Date(),
    apiKey: null, projectId: null, tier, accountId: null, email: null, isActive: true,
    disabledUntil: null, lastUsedAt: null, status: "active",
  } as ProviderAccount;
}

describe("load balancer (ported from load_balancer_test.go)", () => {
  it("effectiveUnhealthyCount decays after idle intervals", () => {
    const now = new Date("2026-05-13T12:00:00Z");
    const lastRequestAt = new Date(now.getTime() - 31 * 60 * 1000);
    const row = { consecutiveErrors: 5, unhealthyCountUpdatedAt: lastRequestAt } as never;
    expect(effectiveUnhealthyCount(row, now)).toBe(2);
  });

  it("effectiveUnhealthyCount does not decay before idle interval", () => {
    const now = new Date("2026-05-13T12:00:00Z");
    const lastRequestAt = new Date(now.getTime() - 9 * 60 * 1000);
    const row = { consecutiveErrors: 5, unhealthyCountUpdatedAt: lastRequestAt } as never;
    expect(effectiveUnhealthyCount(row, now)).toBe(5);
  });

  it("modelHealthStatus starts degraded at two", () => {
    expect(modelHealthStatus(1)).toBe("active");
    expect(modelHealthStatus(2)).toBe("degraded");
  });

  it("cooldownRecoveryCount reduces rounded thirty percent", () => {
    const cases: Record<number, number> = { 1: 1, 2: 1, 3: 2, 5: 3, 10: 7 };
    for (const [input, want] of Object.entries(cases)) {
      expect(cooldownRecoveryCount(Number(input))).toBe(want);
    }
  });

  it("successRecoveryCount reduces unhealthy count", () => {
    const now = new Date("2026-05-13T12:00:00Z");
    const lastRequestAt = new Date(now.getTime() - 9 * 60 * 1000);
    const row = { consecutiveErrors: 2, lastErrorCode: 429, unhealthyCountUpdatedAt: lastRequestAt } as never;
    expect(successRecoveryCount(row, now)).toBe(1);
  });

  it("successRecoveryCount keeps client errors", () => {
    const now = new Date("2026-05-13T12:00:00Z");
    const lastRequestAt = new Date(now.getTime() - 9 * 60 * 1000);
    const row = { consecutiveErrors: 2, lastErrorCode: 400, unhealthyCountUpdatedAt: lastRequestAt } as never;
    expect(successRecoveryCount(row, now)).toBe(2);
  });

  it("successRecoveryCount does not go negative", () => {
    const now = new Date("2026-05-13T12:00:00Z");
    const row = { consecutiveErrors: 0 } as never;
    expect(successRecoveryCount(row, now)).toBe(0);
  });

  it("prioritizeAccounts treats codex paid plans as paid", () => {
    const accounts = [
      account("free-codex", "codex", "free"),
      account("plus-codex", "codex", "plus"),
      account("prolite-codex", "codex", "prolite"),
      account("unknown-codex", "codex", null),
      account("business-usage-codex", "codex", "self_serve_business_usage_based"),
      account("pro-codex", "codex", "pro"),
      account("enterprise-usage-codex", "codex", "enterprise_cbp_usage_based"),
      account("hc-codex", "codex", "hc"),
    ];
    const prioritized = prioritizeAccounts(accounts, false, []);
    expect(prioritized.map((a) => a.id)).toEqual([
      "plus-codex", "prolite-codex", "business-usage-codex", "pro-codex", "enterprise-usage-codex", "hc-codex", "free-codex", "unknown-codex",
    ]);
  });

  it("prioritizeAccounts treats kiro paid plans as paid", () => {
    const accounts = [
      account("free-kiro", "kiro", "free"),
      account("pro-kiro", "kiro", "pro"),
      account("unknown-kiro", "kiro", null),
      account("pro-plus-kiro", "kiro", "pro-plus"),
      account("power-kiro", "kiro", "power"),
    ];
    const prioritized = prioritizeAccounts(accounts, false, []);
    expect(prioritized.map((a) => a.id)).toEqual(["pro-kiro", "pro-plus-kiro", "power-kiro", "free-kiro", "unknown-kiro"]);
  });

  it("prioritizeAccounts uses provider specific paid tiers", () => {
    const accounts = [
      account("team-antigravity", "antigravity", "team"),
      account("standard-antigravity", "antigravity", "standard-tier"),
    ];
    const prioritized = prioritizeAccounts(accounts, false, []);
    expect(prioritized.map((a) => a.id)).toEqual(["standard-antigravity", "team-antigravity"]);
  });

  it("isPaidAccountTier provider-specific", () => {
    expect(isPaidAccountTier("antigravity", "standard-tier")).toBe(true);
    expect(isPaidAccountTier("antigravity", "team")).toBe(false);
    expect(isPaidAccountTier("kiro", "pro-plus")).toBe(true);
    expect(isPaidAccountTier("kiro", "free")).toBe(false);
  });

  it("session affinity prefers sticky account", () => {
    const accounts = [account("zm-1", "zenmux", "free"), account("zm-2", "zenmux", "free"), account("zm-3", "zenmux", "free")];
    const prioritized = prioritizeAccounts(accounts, false, []);
    expect(prioritized[0]!.id).toBe("zm-1");
    const reordered = preferSticky(prioritized, (a) => a.id === "zm-3");
    expect(reordered.map((a) => a.id)).toEqual(["zm-3", "zm-1", "zm-2"]);
  });

  it("session affinity prefer no-op when sticky excluded", () => {
    const accounts = [account("zm-1", "zenmux", "free"), account("zm-2", "zenmux", "free")];
    const prioritized = prioritizeAccounts(accounts, false, []);
    const reordered = preferSticky(prioritized, (a) => a.id === "zm-cooling-down");
    expect(reordered.map((a) => a.id)).toEqual(["zm-1", "zm-2"]);
  });

  it("paidFirst keeps stable order within groups", () => {
    const accounts = [account("a", "codex", "free"), account("b", "codex", "plus"), account("c", "codex", null)];
    expect(paidFirst(accounts).map((a) => a.id)).toEqual(["b", "a", "c"]);
  });
});

describe("quota cache (ported from quota_cache_test.go)", () => {
  it("quotaRawCacheKey does not expose authorization", () => {
    const accountRow = account("acct_1", "codex", null);
    const key = quotaRawCacheKey(accountRow, "codex:usage", "GET", "https://chatgpt.com/backend-api/wham/usage", JSON.stringify({ token: "secret-token" }));
    for (const secret of ["Bearer", "secret-token"]) {
      expect(key).not.toContain(secret);
    }
    expect(key.startsWith("opendum:quota:raw:codex:acct_1:")).toBe(true);
  });

  it("quotaCacheHeaders keeps codex quota headers only", () => {
    const headers: Record<string, string> = {
      "x-codex-primary-used-percent": "42",
      "x-codex-primary-window-minutes": "300",
      "set-cookie": "private",
      authorization: "Bearer response-token",
    };
    const cached = quotaCacheHeaders(headers);
    expect(cached["x-codex-primary-used-percent"]).toEqual(["42"]);
    expect(cached["x-codex-primary-window-minutes"]).toEqual(["300"]);
    expect(cached["set-cookie"]).toBeUndefined();
    expect(cached["authorization"]).toBeUndefined();
  });

  it("quotaRawCacheTTL ranges from one to five minutes", () => {
    for (let i = 0; i < 100; i++) {
      const ttl = quotaRawCacheTTL();
      expect(ttl).toBeGreaterThanOrEqual(60 * 1000);
      expect(ttl).toBeLessThanOrEqual(5 * 60 * 1000);
    }
  });

  it("codexWindowGroup formats free day windows", () => {
    const cases: Array<[number, string]> = [
      [10080, "7d usage"],
      [43200, "30d usage"],
    ];
    for (const [windowMinutes, want] of cases) {
      const [group, ok] = codexWindowGroup("primary", { used_percent: 25, window_minutes: windowMinutes }, "free", true);
      expect(ok).toBe(true);
      expect(group.displayName).toBe(want);
    }
  });

  it("antigravity quota groups keep frontier first", () => {
    const payload = {
      models: {
        "gemini-3.1-pro-high": { quotaInfo: { remainingFraction: 0.8 } },
        "gemini-3.5-flash-medium": { quotaInfo: { remainingFraction: 0.9 } },
        "gpt-oss-120b-medium": { quotaInfo: { remainingFraction: 0.7 } },
        "claude-opus-4-6-thinking": { quotaInfo: { remainingFraction: 0.5 } },
      },
    };
    const groups = antigravityGroups(payload, "standard-tier");
    expect(groups).toHaveLength(2);
    expect(groups[0]!.name).toBe("claude");
    expect(groups[1]!.name).toBe("gemini");
    expect(groups[0]!.displayName).toBe("Claude");
    expect(groups[1]!.displayName).toBe("Gemini");
    expect(groups[0]!.remainingFraction).toBe(0.5);
    expect(groups[1]!.remainingFraction).toBe(0.8);
    expect(groups[0]!.models).toContain("gpt-oss-120b");
    expect(groups[1]!.models).toContain("gemini-3.5-flash");
  });
});

describe("token refresher (ported from token_refresher_test.go)", () => {
  class TestRefreshBufferProvider implements Provider {
    buffer: number;
    called = false;
    constructor(buffer: number) {
      this.buffer = buffer;
    }
    refreshBuffer(): number {
      return this.buffer;
    }
    async makeRequest(): Promise<never> {
      throw new Error("not implemented");
    }
  }

  it("accountNeedsCredentialRefresh uses provider buffer", () => {
    const now = new Date("2026-05-10T12:00:00Z");
    const provider = new TestRefreshBufferProvider(30 * 60 * 1000);
    const within = { expiresAt: new Date(now.getTime() + 29 * 60 * 1000) } as ProviderAccountLike;
    const outside = { expiresAt: new Date(now.getTime() + 31 * 60 * 1000) } as ProviderAccountLike;
    expect(accountNeedsCredentialRefresh(within, provider, now)).toBe(true);
    expect(accountNeedsCredentialRefresh(outside, provider, now)).toBe(false);
  });

  it("tokenRefreshLockKey", () => {
    expect(tokenRefreshLockKey("acct_123")).toBe("opendum:provider-account:refresh-lock:acct_123");
  });

  it("encrypt/decrypt roundtrip for token refresh", () => {
    const secret = "test-secret";
    const encryptedAccess = encrypt(secret, "access-token");
    const encryptedRefresh = encrypt(secret, "refresh-token");
    expect(encryptedAccess).not.toContain("access-token");
    expect(encryptedRefresh).not.toContain("refresh-token");
  });
});
