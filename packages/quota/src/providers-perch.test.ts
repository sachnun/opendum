import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { provider as perchProvider } from "#quota/providers/perch/index.ts";
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

describe("perch quota provider", () => {
  it("requires a token", async () => {
    const result = await perchProvider.fetch(context(async () => jsonResponse({})), account(), "", false);
    assert.equal(result.status, "expired");
  });

  it("maps sessions, monthly use and credits", async () => {
    const result = await perchProvider.fetch(
      context(async () =>
        jsonResponse({
          ok: true,
          usageMeter: { monthlyPt: 5000 },
          creditBalancePt: 120,
          session: { entitlements: [{ key: "usage.monthly_pt", value_json: { limit: 20000 } }] },
        })
      ),
      account(),
      "token",
      false
    );
    assert.equal(result.status, "success");
    assert.equal(result.groups[0]!.name, "monthly-allowance");
    assert.equal(result.groups[0]!.remainingFraction, 0.75);
    assert.equal(result.groups[0]!.remainingLabel, "15000 / 20000 PT");
    assert.equal(result.groups[1]!.name, "credits");
    assert.equal(result.groups[1]!.remainingLabel, "120 PT available");
  });

  it("adds rolling fair-use windows", async () => {
    const result = await perchProvider.fetch(
      context(async () =>
        jsonResponse({
          ok: true,
          usageMeter: {
            monthlyUsd: 10,
            roostRolling: { enabled: true, window7dCapUsd: 50, window7dUsd: 20, window5hCapUsd: 5, window5hUsd: 1 },
          },
          session: {},
        })
      ),
      account(),
      "token",
      false
    );
    const names = result.groups.map((group) => group.name);
    assert.ok(names.includes("fair-use-7d"));
    assert.ok(names.includes("fair-use-5h"));
  });

  it("handles expired and failed sessions", async () => {
    const unauthorized = await perchProvider.fetch(context(async () => jsonResponse({}, 401)), account(), "token", false);
    assert.equal(unauthorized.status, "expired");

    const serverError = await perchProvider.fetch(context(async () => jsonResponse({}, 500)), account(), "token", false);
    assert.equal(serverError.status, "error");
    assert.match(serverError.error, /HTTP 500/);

    const invalid = await perchProvider.fetch(context(async () => new Response("nope")), account(), "token", false);
    assert.equal(invalid.status, "error");

    const rejected = await perchProvider.fetch(context(async () => jsonResponse({ ok: false })), account(), "token", false);
    assert.equal(rejected.status, "error");

    const needsPlan = await perchProvider.fetch(
      context(async () => jsonResponse({ ok: true, session: { tierSelectionRequired: true } })),
      account(),
      "token",
      false
    );
    assert.equal(needsPlan.status, "expired");
  });
});
