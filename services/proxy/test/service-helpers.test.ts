import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { Provider, ProviderAccount } from "@opendum/providers";
import {
  accountAccessDenial,
  accountNeedsCredentialRefresh,
  cooldownRecoveryCount,
  effectiveUnhealthyCount,
  extractSessionId,
  firstUserText,
  isImmediatelyRecoverableStatusCode,
  isPaidAccountTier,
  isSyntheticProviderAccountId,
  latestHealthRequestAt,
  modelHealthStatus,
  normalizeAccessMode,
  normalizeAccountIds,
  normalizeAccountTierAlias,
  nullableTimeBefore,
  orderProvidersByPerformance,
  paidFirst,
  parseRefreshErrorStatusCode,
  prioritizeAccounts,
  proxyAccessRuleRestrictsTier,
  proxyTierSatisfiesRule,
  quotaFallbackTierLocal,
  refreshBufferFor,
  sessionTextContent,
  sortAccountsByProviderPriority,
  successRecoveryCount,
  withTimeout,
  type HealthRow,
} from "../src/core/service-helpers.js";

const MINUTE = 60 * 1000;

function account(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id: "acct-1",
    userId: "user-1",
    provider: "antigravity",
    ...overrides,
  };
}

function healthRow(overrides: Partial<HealthRow> = {}): HealthRow {
  return {
    id: "acct-1",
    consecutiveErrors: 0,
    status: "active",
    unhealthyCountUpdatedAt: null,
    lastErrorAt: null,
    lastSuccessAt: null,
    createdAt: null as never,
    updatedAt: null as never,
    lastErrorCode: null,
    ...overrides,
  };
}

describe("account id helpers", () => {
  it("detects synthetic provider accounts", () => {
    assert.equal(isSyntheticProviderAccountId("opencode"), true);
    assert.equal(isSyntheticProviderAccountId("authless:hyper"), true);
    assert.equal(isSyntheticProviderAccountId("real-account"), false);
  });

  it("normalizes access modes and account id lists", () => {
    assert.equal(normalizeAccessMode("whitelist"), "whitelist");
    assert.equal(normalizeAccessMode("blacklist"), "blacklist");
    assert.equal(normalizeAccessMode("other"), "all");
    assert.deepEqual(normalizeAccountIds([" b", "a", "a", " "]), ["a", "b"]);
  });
});

describe("accountAccessDenial", () => {
  it("allows when the mode is all", () => {
    assert.equal(accountAccessDenial("a", { mode: "all", accounts: ["a"] }), null);
  });

  it("blocks an account missing from a whitelist", () => {
    assert.deepEqual(accountAccessDenial("a", { mode: "whitelist", accounts: ["b"] }), {
      message: "Selected provider account is not allowed for this API key.",
      code: "provider_account_not_whitelisted",
    });
    assert.equal(accountAccessDenial("b", { mode: "whitelist", accounts: ["b"] }), null);
  });

  it("blocks an account present in a blacklist", () => {
    assert.deepEqual(accountAccessDenial("a", { mode: "blacklist", accounts: ["a"] }), {
      message: "Selected provider account is blocked for this API key.",
      code: "provider_account_blacklisted",
    });
    assert.equal(accountAccessDenial("a", { mode: "blacklist", accounts: [] }), null);
  });
});

describe("credential refresh helpers", () => {
  it("uses a provider refresh buffer when available", () => {
    const provider = { name: "x", refreshBuffer: () => 1234 } as unknown as Provider;
    assert.equal(refreshBufferFor(provider), 1234);
    assert.equal(refreshBufferFor({ name: "x" } as Provider), 3 * 60 * 60 * 1000);
  });

  it("decides whether an account needs refresh", () => {
    const now = Date.now();
    assert.equal(accountNeedsCredentialRefresh(account(), { name: "x" } as Provider), false);
    assert.equal(
      accountNeedsCredentialRefresh(account({ expiresAt: new Date(now + 60 * 60 * 1000) }), { name: "x" } as Provider),
      true
    );
    assert.equal(
      accountNeedsCredentialRefresh(account({ expiresAt: new Date(now + 5 * 60 * 60 * 1000) }), { name: "x" } as Provider),
      false
    );
  });

  it("extracts an upstream status code from a refresh error", () => {
    assert.equal(parseRefreshErrorStatusCode(new Error("refresh failed with status 403")), 403);
    assert.equal(parseRefreshErrorStatusCode(new Error("HTTP 500 upstream")), 500);
    assert.equal(parseRefreshErrorStatusCode(new Error("error 4290 invalid")), 401);
    assert.equal(parseRefreshErrorStatusCode(new Error("status 200 ok")), 401);
    assert.equal(parseRefreshErrorStatusCode(new Error("no code")), 401);
    assert.equal(parseRefreshErrorStatusCode(new Error("code 12345 long")), 401);
  });
});

describe("health decay", () => {
  const now = new Date("2026-06-01T12:00:00.000Z");

  it("picks the most recent health timestamp", () => {
    const older = new Date(now.getTime() - 30 * MINUTE);
    const newer = new Date(now.getTime() - 10 * MINUTE);
    assert.equal(
      latestHealthRequestAt(healthRow({ unhealthyCountUpdatedAt: older, lastErrorAt: newer }))?.getTime(),
      newer.getTime()
    );
    assert.equal(latestHealthRequestAt(healthRow({ updatedAt: newer }))?.getTime(), newer.getTime());
    assert.equal(latestHealthRequestAt(healthRow({ createdAt: older }))?.getTime(), older.getTime());
    assert.equal(
      latestHealthRequestAt(healthRow({ unhealthyCountUpdatedAt: older, lastErrorAt: older, lastSuccessAt: newer }))?.getTime(),
      newer.getTime()
    );
  });

  it("decays idle unhealthy counts over time", () => {
    const row = healthRow({ consecutiveErrors: 5, unhealthyCountUpdatedAt: new Date(now.getTime() - 25 * MINUTE) });
    assert.equal(effectiveUnhealthyCount(row, now), 3);
    assert.equal(effectiveUnhealthyCount(healthRow({ consecutiveErrors: 5 }), now), 5);
    assert.equal(effectiveUnhealthyCount(healthRow({ consecutiveErrors: 0 }), now), 0);
    assert.equal(
      effectiveUnhealthyCount(healthRow({ consecutiveErrors: 2, unhealthyCountUpdatedAt: new Date(now.getTime() - 60 * MINUTE) }), now),
      0
    );
  });

  it("maps unhealthy counts to a status", () => {
    assert.equal(modelHealthStatus(0), "active");
    assert.equal(modelHealthStatus(1), "active");
    assert.equal(modelHealthStatus(2), "degraded");
    assert.equal(modelHealthStatus(9), "degraded");
  });

  it("computes cooldown recovery counts", () => {
    assert.equal(cooldownRecoveryCount(0), 0);
    assert.equal(cooldownRecoveryCount(5), 3);
    assert.equal(cooldownRecoveryCount(10), 7);
    assert.equal(cooldownRecoveryCount(1), 1);
  });

  it("decides immediate recoverability by status code", () => {
    assert.equal(isImmediatelyRecoverableStatusCode(408), true);
    assert.equal(isImmediatelyRecoverableStatusCode(429), true);
    assert.equal(isImmediatelyRecoverableStatusCode(500), true);
    assert.equal(isImmediatelyRecoverableStatusCode(503), true);
    assert.equal(isImmediatelyRecoverableStatusCode(400), false);
    assert.equal(isImmediatelyRecoverableStatusCode(401), false);
  });

  it("recovers one unhealthy count after a success", () => {
    const row = healthRow({ consecutiveErrors: 3, lastErrorCode: 429 });
    assert.equal(successRecoveryCount(row, now), 2);
    assert.equal(successRecoveryCount(healthRow({ consecutiveErrors: 3, lastErrorCode: 400 }), now), 3);
    assert.equal(successRecoveryCount(healthRow({ consecutiveErrors: 0 }), now), 0);
  });
});

describe("account ordering", () => {
  it("sorts by provider priority, then status, then last used", () => {
    const accounts = [
      account({ id: "b1", provider: "b" }),
      account({ id: "a1", provider: "a", status: "z" }),
      account({ id: "a2", provider: "a", status: "a" }),
      account({ id: "c1", provider: "c" }),
    ];
    sortAccountsByProviderPriority(accounts, ["a", "b"]);
    assert.deepEqual(
      accounts.map((value) => value.id),
      ["a2", "a1", "b1", "c1"]
    );
  });

  it("orders newer lastUsedAt ahead within the same provider and status", () => {
    const accounts = [
      account({ id: "old", provider: "a", lastUsedAt: new Date("2026-01-01T00:00:00Z") }),
      account({ id: "new", provider: "a", lastUsedAt: new Date("2026-06-01T00:00:00Z") }),
    ];
    sortAccountsByProviderPriority(accounts, ["a"]);
    assert.deepEqual(
      accounts.map((value) => value.id),
      ["old", "new"]
    );
  });

  it("recognizes paid tiers per provider", () => {
    assert.equal(isPaidAccountTier("antigravity", "paid"), true);
    assert.equal(isPaidAccountTier("antigravity", "standard-tier"), true);
    assert.equal(isPaidAccountTier("antigravity", "g1-pro"), true);
    assert.equal(isPaidAccountTier("antigravity", "free"), false);
    assert.equal(isPaidAccountTier("kiro", "pro"), true);
    assert.equal(isPaidAccountTier("kiro", "power"), true);
    assert.equal(isPaidAccountTier("kiro", "free"), false);
    assert.equal(isPaidAccountTier("other", " TEAM "), true);
    assert.equal(isPaidAccountTier("other", null), false);
  });

  it("puts paid accounts ahead of free ones", () => {
    const accounts = [
      account({ id: "free", provider: "x" }),
      account({ id: "paid", provider: "x", tier: "pro" }),
      account({ id: "opencode", provider: "opencode" }),
    ];
    assert.deepEqual(
      paidFirst(accounts).map((value) => value.id),
      ["paid", "free", "opencode"]
    );
  });

  it("prioritizes accounts across providers when grouping is on", () => {
    const accounts = [
      account({ id: "b1", provider: "b" }),
      account({ id: "a1", provider: "a" }),
      account({ id: "a2", provider: "a", tier: "pro" }),
    ];
    const ordered = prioritizeAccounts(accounts, true, ["b", "a"]);
    assert.deepEqual(
      ordered.map((value) => value.id),
      ["b1", "a2", "a1"]
    );
  });

  it("falls back to paid-first when grouping is off", () => {
    const accounts = [account({ id: "free" }), account({ id: "paid", provider: "openai", tier: "pro" })];
    assert.deepEqual(
      prioritizeAccounts(accounts, false, []).map((value) => value.id),
      ["paid", "free"]
    );
  });

  it("orders providers by priority then appends unknown ones", () => {
    assert.deepEqual(orderProvidersByPerformance(["b", "c", "a"], ["c", "a"]), ["c", "a", "b"]);
  });

  it("promotes the best performing provider without exploration", () => {
    const scores = new Map([
      ["a", { score: 1 }],
      ["b", { score: 2 }],
    ]) as never;
    const result = orderProvidersByPerformance(["a", "b"], ["a", "b"], {
      scores,
      bufferRatio: 0,
      explorationRate: 0,
    }, () => 0);
    assert.equal(result[0], "a");
  });

  it("explores a non-pool provider when the random draw allows", () => {
    const scores = new Map([
      ["a", { score: 1 }],
      ["b", { score: 2 }],
      ["c", { score: 3 }],
    ]) as never;
    const result = orderProvidersByPerformance(["a", "b", "c"], ["a", "b", "c"], {
      scores,
      bufferRatio: 0,
      explorationRate: 1,
    }, () => 0.5);
    assert.deepEqual(result, ["c", "a", "b"]);
  });
});

describe("time helpers", () => {
  it("compares nullable times", () => {
    assert.equal(nullableTimeBefore(null, null), false);
    assert.equal(nullableTimeBefore(null, new Date()), true);
    assert.equal(nullableTimeBefore(new Date(), null), false);
    assert.equal(nullableTimeBefore(new Date(0), new Date(1)), true);
    assert.equal(nullableTimeBefore(new Date(1), new Date(0)), false);
  });

  it("resolves withTimeout results and rejects on timeout", async () => {
    assert.equal(await withTimeout(Promise.resolve("ok"), 1000), "ok");
    await assert.rejects(withTimeout(new Promise(() => undefined), 5), /timed out/);
    await assert.rejects(withTimeout(Promise.reject(new Error("upstream failed")), 1000), /upstream failed/);
  });
});

describe("tier rule helpers", () => {
  it("normalizes tier aliases", () => {
    assert.equal(normalizeAccountTierAlias("pro_plus"), "pro+");
    assert.equal(normalizeAccountTierAlias("ProPlus"), "pro+");
    assert.equal(normalizeAccountTierAlias("free-tier"), "free");
    assert.equal(normalizeAccountTierAlias("Education"), "student");
    assert.equal(normalizeAccountTierAlias("  PRO  "), "pro");
  });

  it("evaluates tier rules", () => {
    assert.equal(proxyTierSatisfiesRule("pro_plus", "pro+", undefined), true);
    assert.equal(proxyTierSatisfiesRule("free", "free", undefined), true);
    assert.equal(proxyTierSatisfiesRule("free", "pro", undefined), false);
    assert.equal(proxyTierSatisfiesRule("student", undefined, ["education"]), true);
    assert.equal(proxyTierSatisfiesRule("free", undefined, ["pro"]), false);
  });

  it("detects restricting rules", () => {
    assert.equal(proxyAccessRuleRestrictsTier(undefined, undefined), false);
    assert.equal(proxyAccessRuleRestrictsTier("free", undefined), false);
    assert.equal(proxyAccessRuleRestrictsTier("pro", undefined), true);
    assert.equal(proxyAccessRuleRestrictsTier(undefined, ["free"]), true);
  });

  it("falls back to free when a tier is blank", () => {
    assert.equal(quotaFallbackTierLocal(account({ tier: "  " })), "free");
    assert.equal(quotaFallbackTierLocal(account({ tier: " Pro " })), "Pro");
    assert.equal(quotaFallbackTierLocal(account({ tier: null })), "free");
  });
});

describe("session extraction", () => {
  it("prefers session headers", () => {
    const request = new Request("http://localhost/", {
      headers: { "x-claude-code-session-id": " header-session " },
    });
    assert.equal(extractSessionId(request, {}), "header-session");
  });

  it("reads well-known body keys", () => {
    assert.equal(extractSessionId(new Request("http://localhost/"), { prompt_cache_key: " body-1 " }), "body-1");
    assert.equal(extractSessionId(new Request("http://localhost/"), { sessionId: "body-2" }), "body-2");
  });

  it("derives claude session ids from metadata", () => {
    const body = { metadata: { user_id: "user_abc_session_deadbeef" } };
    assert.equal(extractSessionId(new Request("http://localhost/"), body), "claude:deadbeef");
    assert.equal(
      extractSessionId(new Request("http://localhost/"), { metadata: { user_id: "plain-user" } }),
      "plain-user"
    );
  });

  it("hashes long first user text", () => {
    const body = { messages: [{ role: "user", content: "x".repeat(40) }] };
    const session = extractSessionId(new Request("http://localhost/"), body);
    assert.match(session, /^prompt:[0-9a-f]{16}$/);
  });

  it("returns empty when nothing matches", () => {
    assert.equal(extractSessionId(new Request("http://localhost/"), {}), "");
    assert.equal(extractSessionId(new Request("http://localhost/"), { messages: [{ role: "user", content: "short" }] }), "");
  });
});

describe("message text extraction", () => {
  it("flattens text content parts", () => {
    assert.equal(sessionTextContent("hello"), "hello");
    assert.equal(sessionTextContent([{ text: "a" }, { text: " b " }, { notText: 1 }]), "a\nb");
    assert.equal(sessionTextContent(42), "");
  });

  it("returns the first user text from chat messages", () => {
    assert.equal(
      firstUserText({ messages: [{ role: "assistant", content: "no" }, { role: "user", content: "yes" }] }),
      "yes"
    );
  });

  it("returns the first user text from responses input", () => {
    assert.equal(firstUserText({ input: [{ role: "user", content: [{ text: "input text" }] }] }), "input text");
  });

  it("returns empty when there is no user text", () => {
    assert.equal(firstUserText({}), "");
    assert.equal(firstUserText({ messages: [{ role: "user", content: [] }] }), "");
  });
});
