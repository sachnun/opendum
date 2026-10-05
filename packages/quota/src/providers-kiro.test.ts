import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { provider as kiroProvider } from "#quota/providers/kiro/index.ts";
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

describe("kiro quota provider", () => {
  it("maps usage limits", async () => {
    const result = await kiroProvider.fetch(
      context(async () => jsonResponse({ data: { limits: [{ type: "AI_EDITOR", currentUsage: 1, totalUsageLimit: 10 }] } })),
      account({ provider: "kiro" }),
      "token",
      false
    );
    assert.equal(result.status, "success");
    const group = result.groups[0]!;
    assert.equal(group.name, "ai_editor");
    assert.equal(group.displayName, "Kiro requests");
    assert.equal(group.remainingFraction, 0.9);
    assert.equal(group.remainingRequests, 9);
  });

  it("maps usageBreakdownList entries", async () => {
    const result = await kiroProvider.fetch(
      context(async () =>
        jsonResponse({ data: { usageBreakdownList: [{ resourceType: "CODE_COMPLETIONS", currentUsage: 5, usageLimit: 10 }] } })
      ),
      account({ provider: "kiro" }),
      "token",
      false
    );
    assert.equal(result.status, "success");
    assert.equal(result.groups[0]!.name, "code_completions");
    assert.equal(result.groups[0]!.displayName, "Code completions");
    assert.equal(result.groups[0]!.remainingFraction, 0.5);
  });

  it("errors on invalid json, failed requests and empty payloads", async () => {
    const invalid = await kiroProvider.fetch(
      context(async () => new Response("nope", { status: 200 })),
      account({ provider: "kiro" }),
      "token",
      false
    );
    assert.equal(invalid.status, "error");
    assert.match(invalid.error, /not valid JSON/);

    const failed = await kiroProvider.fetch(
      context(async () => jsonResponse({}, 500)),
      account({ provider: "kiro" }),
      "token",
      false
    );
    assert.equal(failed.status, "error");
    assert.match(failed.error, /HTTP 500/);

    const empty = await kiroProvider.fetch(
      context(async () => jsonResponse({ data: {} })),
      account({ provider: "kiro" }),
      "token",
      false
    );
    assert.equal(empty.status, "error");
    assert.match(empty.error, /unavailable/);
  });
});
