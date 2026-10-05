import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { provider as hyperProvider } from "#quota/providers/hyper/index.ts";
import { provider as zenmuxProvider } from "#quota/providers/zenmux/index.ts";
import { provider as openrouterProvider } from "#quota/providers/openrouter/index.ts";
import { provider as codexProvider } from "#quota/providers/codex/index.ts";
import type { QuotaAccount, QuotaContext } from "#quota/types.ts";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function context(fetchImpl: QuotaContext["fetch"], overrides: Partial<QuotaContext> = {}): QuotaContext {
  return {
    fetch: fetchImpl,
    journal: null,
    decrypt: (value) => value,
    getCredentials: async () => "",
    ...overrides,
  };
}

function account(overrides: Partial<QuotaAccount> = {}): QuotaAccount {
  return { id: "a1", userId: "u1", provider: "hyper", accessToken: "key", ...overrides };
}

describe("hyper quota provider", () => {
  it("reports a dollar balance", async () => {
    const result = await hyperProvider.fetch(
      context(async () => jsonResponse({ balance: 20 })),
      account(),
      "",
      false
    );
    assert.equal(result.status, "success");
    assert.equal(result.groups[0]!.remainingLabel, "$1.00");
  });

  it("falls back to an active label when balance is missing", async () => {
    const result = await hyperProvider.fetch(context(async () => jsonResponse({})), account(), "", false);
    assert.equal(result.status, "success");
    assert.equal(result.groups[0]!.remainingLabel, "active");
  });

  it("reports an expired account when decryption fails", async () => {
    const result = await hyperProvider.fetch(
      context(async () => jsonResponse({ balance: 1 }), {
        decrypt: () => {
          throw new Error("bad key");
        },
      }),
      account(),
      "",
      false
    );
    assert.equal(result.status, "expired");
    assert.match(result.error, /missing or invalid/);
  });

  it("reports an error on a failed request", async () => {
    const result = await hyperProvider.fetch(context(async () => jsonResponse({}, 500)), account(), "", false);
    assert.equal(result.status, "error");
    assert.match(result.error, /HTTP 500/);

    const thrown = await hyperProvider.fetch(
      context(async () => {
        throw new Error("network down");
      }),
      account(),
      "",
      false
    );
    assert.equal(thrown.status, "error");
    assert.match(thrown.error, /network down/);
  });
});

describe("zenmux quota provider", () => {
  const response = {
    data: {
      quota_5_hour: { max_flows: 100, used_flows: 20, remaining_flows: 80 },
    },
  };

  it("requires a platform key", async () => {
    const result = await zenmuxProvider.fetch(
      context(async () => jsonResponse(response)),
      account({ provider: "zenmux", accountId: null }),
      "",
      false
    );
    assert.equal(result.status, "expired");
    assert.match(result.error, /Platform key/);
  });

  it("maps subscription windows", async () => {
    const result = await zenmuxProvider.fetch(
      context(async () => jsonResponse(response)),
      account({ provider: "zenmux", accountId: "pk-1" }),
      "",
      false
    );
    assert.equal(result.status, "success");
    const group = result.groups[0]!;
    assert.equal(group.name, "quota_5_hour");
    assert.equal(group.remainingFraction, 0.8);
    assert.equal(group.remainingLabel, "80 / 100 flows");
    assert.equal(group.remainingRequests, 80);
    assert.equal(group.maxRequests, 100);
  });

  it("errors when the response has no data payload", async () => {
    const result = await zenmuxProvider.fetch(
      context(async () => jsonResponse({})),
      account({ provider: "zenmux", accountId: "pk-1" }),
      "",
      false
    );
    assert.equal(result.status, "error");
    assert.match(result.error, /did not include data/);
  });

  it("falls back to an account-status group when no window matches", async () => {
    const result = await zenmuxProvider.fetch(
      context(async () => jsonResponse({ data: { other: true } })),
      account({ provider: "zenmux", accountId: "pk-1" }),
      "",
      false
    );
    assert.equal(result.status, "success");
    assert.equal(result.groups[0]!.name, "account-status");
    assert.equal(result.groups[0]!.remainingLabel, "active");
  });

  it("reports request errors", async () => {
    const result = await zenmuxProvider.fetch(
      context(async () => jsonResponse({}, 500)),
      account({ provider: "zenmux", accountId: "pk-1" }),
      "",
      false
    );
    assert.equal(result.status, "error");
    assert.match(result.error, /HTTP 500/);
  });
});

describe("openrouter quota provider", () => {
  function routing(routes: Record<string, () => Response>): QuotaContext["fetch"] {
    return async (url) => (routes[url] ? routes[url]!() : jsonResponse({}, 404));
  }

  it("combines account credits and key limits", async () => {
    const result = await openrouterProvider.fetch(
      context(
        routing({
          "https://openrouter.ai/api/v1/key": () => jsonResponse({ data: { limit: 5, limit_remaining: 2, usage: 3 } }),
          "https://openrouter.ai/api/v1/credits": () => jsonResponse({ data: { total_credits: 10, total_usage: 3 } }),
        })
      ),
      account({ provider: "openrouter" }),
      "",
      false
    );
    assert.equal(result.status, "success");
    assert.equal(result.groups[0]!.name, "account-credits");
    assert.equal(result.groups[0]!.remainingLabel, "$7.00 / $10.00");
    assert.equal(result.groups[1]!.name, "key-limit");
    assert.equal(result.groups[1]!.remainingLabel, "$2.00 / $5.00");
  });

  it("falls back to daily usage and free tier labels", async () => {
    const daily = await openrouterProvider.fetch(
      context(
        routing({
          "https://openrouter.ai/api/v1/key": () => jsonResponse({ data: { usage_daily: 1.5 } }),
          "https://openrouter.ai/api/v1/credits": () => jsonResponse({ data: {} }),
        })
      ),
      account({ provider: "openrouter" }),
      "",
      false
    );
    assert.equal(daily.groups[0]!.name, "daily-usage");
    assert.equal(daily.groups[0]!.remainingLabel, "$1.50");

    const free = await openrouterProvider.fetch(
      context(
        routing({
          "https://openrouter.ai/api/v1/key": () => jsonResponse({ data: { is_free_tier: true } }),
          "https://openrouter.ai/api/v1/credits": () => jsonResponse({ data: {} }),
        })
      ),
      account({ provider: "openrouter" }),
      "",
      false
    );
    assert.equal(free.groups[0]!.remainingLabel, "free tier");
  });

  it("errors when both requests fail and when decryption fails", async () => {
    const failed = await openrouterProvider.fetch(
      context(routing({})),
      account({ provider: "openrouter" }),
      "",
      false
    );
    assert.equal(failed.status, "error");

    const expired = await openrouterProvider.fetch(
      context(async () => jsonResponse({}), {
        decrypt: () => {
          throw new Error("bad key");
        },
      }),
      account({ provider: "openrouter" }),
      "",
      false
    );
    assert.equal(expired.status, "expired");
  });
});

describe("codex quota provider", () => {
  it("maps api rate limit windows", async () => {
    const result = await codexProvider.fetch(
      context(async () =>
        jsonResponse({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 20, window_minutes: 300, reset_at: 0 } } })
      ),
      account({ provider: "codex" }),
      "token",
      false
    );
    assert.equal(result.status, "success");
    const group = result.groups[0]!;
    assert.equal(group.name, "primary");
    assert.equal(group.displayName, "5 hour usage");
    assert.equal(group.remainingFraction, 0.8);
    assert.equal(group.remainingRequests, 80);
  });

  it("falls back to response headers on a non-2xx status", async () => {
    const result = await codexProvider.fetch(
      context(
        async () =>
          new Response("nope", {
            status: 500,
            headers: { "x-codex-primary-used-percent": "50", "x-codex-primary-window-minutes": "300" },
          })
      ),
      account({ provider: "codex" }),
      "token",
      false
    );
    assert.equal(result.status, "success");
    assert.equal(result.groups[0]!.remainingFraction, 0.5);
  });

  it("errors without usable quota data", async () => {
    const failed = await codexProvider.fetch(context(async () => jsonResponse({}, 500)), account({ provider: "codex" }), "t", false);
    assert.equal(failed.status, "error");

    const empty = await codexProvider.fetch(context(async () => jsonResponse({})), account({ provider: "codex" }), "t", false);
    assert.equal(empty.status, "error");
    assert.match(empty.error, /usable quota data/);
  });
});

