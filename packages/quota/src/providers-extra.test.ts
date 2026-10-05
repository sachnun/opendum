import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { provider as antigravityProvider } from "#quota/providers/antigravity/index.ts";
import { provider as workbuddyProvider } from "#quota/providers/workbuddy/index.ts";
import { provider as codexProvider } from "#quota/providers/codex/index.ts";
import type { QuotaAccount, QuotaContext } from "#quota/types.ts";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function context(fetchFn: QuotaContext["fetch"], journal: QuotaContext["journal"] = null): QuotaContext {
  return { fetch: fetchFn, journal } as unknown as QuotaContext;
}

function account(overrides: Partial<QuotaAccount> = {}): QuotaAccount {
  return { id: "a1", provider: "test", accountId: null, projectId: null, ...overrides } as unknown as QuotaAccount;
}

describe("antigravity quota provider", () => {
  it("requires a project id", async () => {
    const result = await antigravityProvider.fetch(context(async () => jsonResponse({})), account(), "token", false);
    assert.equal(result.status, "error");
    assert.match(result.error, /missing projectId/);
  });

  it("maps per-model fractions into claude and gemini groups", async () => {
    const result = await antigravityProvider.fetch(
      context(async () =>
        jsonResponse({
          models: {
            "claude-sonnet": { quotaInfo: { remainingFraction: 0.25, resetTime: "2030-01-01T00:00:00Z" } },
            "gemini-pro": { quotaInfo: { remainingFraction: 0.5 } },
          },
        })
      ),
      account({ projectId: "p1" }),
      "token",
      false
    );
    assert.equal(result.status, "success");
    assert.equal(result.groups[0]!.name, "claude");
    assert.equal(result.groups[0]!.remainingFraction, 0.25);
    assert.equal(result.groups[0]!.remainingRequests, 25);
    assert.equal(result.groups[1]!.name, "gemini");
    assert.equal(result.groups[1]!.remainingRequests, 50);
  });

  it("defaults to full fractions with no model data", async () => {
    const result = await antigravityProvider.fetch(context(async () => jsonResponse({})), account({ projectId: "p1" }), "token", false);
    assert.equal(result.groups[0]!.remainingFraction, 1);
    assert.equal(result.groups[1]!.remainingFraction, 1);
  });

  it("reports HTTP and network failures", async () => {
    const failed = await antigravityProvider.fetch(
      context(async () => jsonResponse({}, 500)),
      account({ projectId: "p1" }),
      "token",
      false
    );
    assert.equal(failed.status, "error");
    assert.match(failed.error, /HTTP 500/);

    const thrown = await antigravityProvider.fetch(
      context(async () => {
        throw new Error("boom");
      }),
      account({ projectId: "p1" }),
      "token",
      false
    );
    assert.equal(thrown.status, "error");
    assert.match(thrown.error, /boom/);
  });

  it("reports invalid JSON", async () => {
    const result = await antigravityProvider.fetch(
      context(async () => new Response("nope", { status: 200 })),
      account({ projectId: "p1" }),
      "token",
      false
    );
    assert.equal(result.status, "error");
  });
});

describe("workbuddy quota provider", () => {
  function routing(routes: Record<string, () => Response>): QuotaContext["fetch"] {
    return async (url) => (routes[url] ? routes[url]!() : jsonResponse({}, 404));
  }

  const summaryUrl = "https://www.workbuddy.ai/billing/meter/get-user-resource-summary";
  const freeUrl = "https://www.workbuddy.ai/billing/meter/get-user-resource-free-packages";
  const paidUrl = "https://www.workbuddy.ai/billing/meter/get-user-resource-paid-packages";

  it("requires a token", async () => {
    const result = await workbuddyProvider.fetch(context(async () => jsonResponse({})), account(), "", false);
    assert.equal(result.status, "expired");
  });

  it("maps package capacity and details", async () => {
    const result = await workbuddyProvider.fetch(
      context(
        routing({
          [summaryUrl]: () => jsonResponse({ code: 0, data: { Packages: [{ PackageCode: "TCACA_code_006", CycleTotalCapacity: 100, CycleRemainCapacity: 60, CycleUsedCapacity: 40 }] } }),
          [freeUrl]: () => jsonResponse({ code: 0, data: { Accounts: [{ PackageCode: "TCACA_code_006", PackageName: "", CycleEndTime: "2030-01-01T00:00:00Z" }] } }),
          [paidUrl]: () => jsonResponse({ code: 0, data: { Accounts: [] } }),
        })
      ),
      account({ accountId: "u1" }),
      "token",
      false
    );
    assert.equal(result.status, "success");
    assert.equal(result.groups[0]!.name, "TCACA_code_006");
    assert.equal(result.groups[0]!.displayName, "Bonus Pack");
    assert.equal(result.groups[0]!.remainingFraction, 0.6);
    assert.equal(result.groups[0]!.remainingLabel, "60 / 100 credits");
  });

  it("normalizes package names and survives detail failures", async () => {
    const result = await workbuddyProvider.fetch(
      context(
        routing({
          [summaryUrl]: () => jsonResponse({ code: 0, data: { Packages: [{ PackageCode: "TCACA_code_035", CycleTotalCapacity: 10, CycleRemainCapacity: 10, CycleUsedCapacity: 0 }] } }),
          [freeUrl]: () => jsonResponse({}, 500),
          [paidUrl]: () => jsonResponse({ code: 1 }),
        })
      ),
      account(),
      "token",
      false
    );
    assert.equal(result.groups[0]!.displayName, "Free Plan");
  });

  it("reports failed requests", async () => {
    const unauthorized = await workbuddyProvider.fetch(context(async () => jsonResponse({}, 401)), account(), "token", false);
    assert.equal(unauthorized.status, "expired");

    const serverError = await workbuddyProvider.fetch(context(async () => jsonResponse({}, 500)), account(), "token", false);
    assert.equal(serverError.status, "error");

    const invalid = await workbuddyProvider.fetch(context(async () => new Response("nope")), account(), "token", false);
    assert.equal(invalid.status, "error");

    const rejected = await workbuddyProvider.fetch(context(async () => jsonResponse({ code: 7, msg: "bad" })), account(), "token", false);
    assert.equal(rejected.status, "error");
    assert.match(rejected.error, /7/);

    const empty = await workbuddyProvider.fetch(
      context(routing({ [summaryUrl]: () => jsonResponse({ code: 0, data: { Packages: [] } }) })),
      account(),
      "token",
      false
    );
    assert.equal(empty.status, "error");

    const thrown = await workbuddyProvider.fetch(
      context(async () => {
        throw new Error("boom");
      }),
      account(),
      "token",
      false
    );
    assert.equal(thrown.status, "error");
  });

  it("skips package detail failures", async () => {
    const result = await workbuddyProvider.fetch(
      context(
        routing({
          [summaryUrl]: () => jsonResponse({ code: 0, data: { Packages: [{ PackageCode: "pkg", CycleTotalCapacity: 10, CycleRemainCapacity: 5, CycleUsedCapacity: 5 }] } }),
          [freeUrl]: () => new Response("not json", { status: 200 }),
          [paidUrl]: () => jsonResponse({ code: 1 }),
        })
      ),
      account(),
      "token",
      false
    );
    assert.equal(result.status, "success");
    assert.equal(result.groups[0]!.displayName, "pkg");
  });

  it("skips packages without codes", async () => {
    const result = await workbuddyProvider.fetch(
      context(
        routing({
          [summaryUrl]: () => jsonResponse({ code: 0, data: { Packages: [{ CycleTotalCapacity: 10, CycleRemainCapacity: 10, CycleUsedCapacity: 0 }] } }),
        })
      ),
      account(),
      "token",
      false
    );
    assert.equal(result.status, "success");
    assert.equal(result.groups[0]!.name, "package");
  });

  it("loads package details and strips random suffixes", async () => {
    const code = "TCACA_code_099_abcdEFGH12";
    const result = await workbuddyProvider.fetch(
      context(
        routing({
          [summaryUrl]: () => jsonResponse({ code: 0, data: { Packages: [{ PackageCode: code, CycleTotalCapacity: 10, CycleRemainCapacity: 10, CycleUsedCapacity: 0 }] } }),
          [freeUrl]: () => jsonResponse({ code: 0, data: { Accounts: [{ PackageCode: code, PackageName: "", CycleEndTime: "2030-01-01T00:00:00Z" }] } }),
          [paidUrl]: () => jsonResponse({ code: 0, data: { Accounts: [{ PackageCode: "other", PackageName: "Named" }] } }),
        })
      ),
      account(),
      "token",
      false
    );
    assert.equal(result.status, "success");
    assert.equal(result.groups[0]!.name, code);
  });

  it("tolerates detail endpoint failures", async () => {
    const result = await workbuddyProvider.fetch(
      context(
        routing({
          [summaryUrl]: () => jsonResponse({ code: 0, data: { Packages: [{ PackageCode: "pkg", CycleTotalCapacity: 10, CycleRemainCapacity: 10, CycleUsedCapacity: 0 }] } }),
          [freeUrl]: () => {
            throw new Error("boom");
          },
          [paidUrl]: () => jsonResponse({}, 500),
        })
      ),
      account(),
      "token",
      false
    );
    assert.equal(result.status, "success");
  });
});

describe("codex quota edge cases", () => {
  function jwt(payload: Record<string, unknown>): string {
    return `header.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.sig`;
  }

  it("handles invalid JSON bodies", async () => {
    const result = await codexProvider.fetch(
      context(async () => new Response("not json", { status: 200 })),
      account({ provider: "codex" }),
      "token",
      false
    );
    assert.equal(result.status, "error");
  });

  it("extracts account ids from JWTs", async () => {
    const cases = [
      jwt({ chatgpt_account_id: "acc1" }),
      jwt({ "https://api.openai.com/auth": { chatgpt_workspace_id: "ws1" } }),
      jwt({ workspace_id: "ws2" }),
      jwt({ organization_id: "org1" }),
      "not-a-jwt",
      "header.invalid-base64!.sig",
    ];
    for (const token of cases) {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      await codexProvider.fetch(
        context(async (url, init) => {
          calls.push({ url, init });
          return jsonResponse({ rate_limit: { primary_window: { used_percent: 10, window_minutes: 300 } } });
        }),
        account({ provider: "codex", accountId: null }),
        token,
        false
      );
      assert.equal(calls.length, 1);
    }
  });
});
