import assert from "node:assert/strict";
import { beforeEach, describe, it, vi } from "vitest";
import type { AuthResult, ModelValidationResult } from "@opendum/auth";
import type { ProviderAccount } from "@opendum/providers";

const mocks = vi.hoisted(() => ({
  db: {
    getCustomProvider: vi.fn(),
    getForcedAccount: vi.fn(),
    listCustomProviderModels: vi.fn(),
  },
  accounts: {
    canAccountUseModel: vi.fn(),
    getNextAvailableAccount: vi.fn(),
    getNextSharedAccount: vi.fn(),
  },
  creds: { makeProviderRequest: vi.fn() },
  points: { reserveRoamingPoint: vi.fn(), refundRoamingPoint: vi.fn() },
  health: {
    bumpAccountRequestCountDeferred: vi.fn(),
    logAccountError: vi.fn(),
    logUsage: vi.fn(),
    markAccountFailed: vi.fn(),
    markAccountUsageLimited: vi.fn(),
    refreshAccountHealthFromModels: vi.fn(),
  },
}));

vi.mock("@opendum/database/queries", () => mocks.db);
vi.mock("../src/core/service-accounts.js", () => mocks.accounts);
vi.mock("../src/core/service-credentials.js", () => mocks.creds);
vi.mock("../src/core/points.js", () => mocks.points);
vi.mock("../src/core/service-health.js", () => mocks.health);

import {
  executeWithAccountRotation,
  modelAccountSelector,
  validateForcedAccount,
} from "../src/core/service-routing.js";
import type { ProxyDeps } from "../src/core/service-deps.js";
import type { AttemptResult, EndpointAdapter, ParsedEndpointRequest } from "../src/core/types.js";

function deps(overrides: Record<string, unknown> = {}): ProxyDeps {
  return {
    database: {},
    models: {
      modelsForProvider: () => [],
      isSupportedByProvider: () => true,
      isAuthlessProviderModel: () => false,
      isVisionModel: () => true,
      resolveAlias: (model: string) => model,
      providersForModel: () => ["kiro"],
    },
    providers: { has: () => false, isAuthless: () => false },
    redis: {},
    auth: {},
    performance: {},
    ...overrides,
  } as unknown as ProxyDeps;
}

function account(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return { id: "a1", userId: "u1", provider: "kiro", isActive: true, status: "active", tier: "pro", ...overrides };
}

function authResult(overrides: Partial<AuthResult> = {}): AuthResult {
  return {
    valid: true,
    userId: "u1",
    apiKeyId: "k1",
    modelAccessMode: "all",
    modelAccessList: [],
    accountAccessMode: "all",
    accountAccessList: [],
    roamingEnabled: false,
    rateLimitRules: [],
    error: "",
    ...overrides,
  };
}

function validation(overrides: Partial<ModelValidationResult> = {}): ModelValidationResult {
  return { valid: true, provider: null, model: "m", alias: "", vision: null, error: "", param: "", code: "", ...overrides };
}

function parsed(): ParsedEndpointRequest {
  return { modelParam: "m", stream: false, forcedAccountId: null, reasoningRequested: false, messagesForError: [], paramsForError: {}, routeData: {} };
}

function cfg(): EndpointAdapter {
  return {
    endpoint: "chat_completions",
    noAccountsStatusCode: 404,
    build: () => ({ model: "m" }),
  } as unknown as EndpointAdapter;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.db.getCustomProvider.mockResolvedValue(null);
  mocks.db.getForcedAccount.mockResolvedValue(null);
  mocks.db.listCustomProviderModels.mockResolvedValue([]);
  mocks.accounts.canAccountUseModel.mockReturnValue(true);
  mocks.accounts.getNextAvailableAccount.mockResolvedValue({ account: null, configured: false });
  mocks.accounts.getNextSharedAccount.mockResolvedValue({ account: null, configured: false });
  mocks.creds.makeProviderRequest.mockResolvedValue(new Response("ok", { status: 200 }));
  mocks.points.reserveRoamingPoint.mockResolvedValue(null);
  mocks.points.refundRoamingPoint.mockResolvedValue(undefined);
  mocks.health.bumpAccountRequestCountDeferred.mockResolvedValue(undefined);
  mocks.health.logAccountError.mockResolvedValue(undefined);
  mocks.health.logUsage.mockResolvedValue(undefined);
  mocks.health.markAccountFailed.mockResolvedValue(new Date());
  mocks.health.markAccountUsageLimited.mockResolvedValue(undefined);
  mocks.health.refreshAccountHealthFromModels.mockResolvedValue(false);
});

describe("modelAccountSelector", () => {
  it("parses account prefixes", async () => {
    assert.equal(await modelAccountSelector(deps(), "nomodel", "u1"), null);
    assert.deepEqual(await modelAccountSelector(deps(), "acc1/model-x", "u1"), { accountId: "acc1", model: "model-x" });
  });

  it("rejects known providers and custom providers", async () => {
    const knownProvider = deps({ providers: { has: () => true, isAuthless: () => false } });
    assert.equal(await modelAccountSelector(knownProvider, "codex/m", "u1"), null);

    const knownModelProvider = deps({
      models: { modelsForProvider: () => ["x"], isSupportedByProvider: () => true, resolveAlias: (m: string) => m },
    });
    assert.equal(await modelAccountSelector(knownModelProvider, "codex/m", "u1"), null);

    mocks.db.getCustomProvider.mockResolvedValueOnce({ id: "cp1" });
    assert.equal(await modelAccountSelector(deps(), "custom/m", "u1"), null);
  });
});

describe("validateForcedAccount", () => {
  it("handles empty and missing accounts", async () => {
    assert.equal(await validateForcedAccount(deps(), "u1", validation(), null, { mode: "all", accounts: [] }), null);

    const empty = await validateForcedAccount(deps(), "u1", validation(), "   ", { mode: "all", accounts: [] });
    assert.equal((empty as { code: string }).code, "invalid_provider_account");

    const missing = await validateForcedAccount(deps(), "u1", validation(), "a1", { mode: "all", accounts: [] });
    assert.equal((missing as { code: string }).code, "provider_account_not_found");
  });

  it("enforces access lists", async () => {
    const denied = await validateForcedAccount(deps(), "u1", validation(), "a1", { mode: "whitelist", accounts: ["other"] });
    assert.equal((denied as { status: number }).status, 403);
  });

  it("accepts synthetic accounts", async () => {
    const providerAuthless = deps({ providers: { has: () => false, isAuthless: (id: string) => id === "opencode" } });
    const synthetic = await validateForcedAccount(providerAuthless, "u1", validation(), "opencode", { mode: "all", accounts: [] });
    assert.equal((synthetic as ProviderAccount).id, "opencode");

    const prefixed = deps({ models: { isAuthlessProviderModel: () => true, isSupportedByProvider: () => true, resolveAlias: (m: string) => m } });
    const authless = await validateForcedAccount(prefixed, "u1", validation(), "authless:kiro", { mode: "all", accounts: [] });
    assert.equal((authless as ProviderAccount).id, "authless:kiro");
  });

  it("rejects inactive, disabled and cooling accounts", async () => {
    mocks.db.getForcedAccount.mockResolvedValueOnce(account({ isActive: false }));
    const inactive = await validateForcedAccount(deps(), "u1", validation(), "a1", { mode: "all", accounts: [] });
    assert.equal((inactive as { code: string }).code, "provider_account_inactive");

    mocks.db.getForcedAccount.mockResolvedValueOnce(account({ disabledUntil: new Date(Date.now() + 60000) }));
    const disabled = await validateForcedAccount(deps(), "u1", validation(), "a1", { mode: "all", accounts: [] });
    assert.equal((disabled as { code: string }).code, "provider_account_temporarily_disabled");

    mocks.db.getForcedAccount.mockResolvedValueOnce(account());
    mocks.health.refreshAccountHealthFromModels.mockResolvedValueOnce(true);
    const cooling = await validateForcedAccount(deps(), "u1", validation(), "a1", { mode: "all", accounts: [] });
    assert.equal((cooling as { code: string }).code, "provider_account_temporarily_disabled");
  });

  it("validates model and provider compatibility", async () => {
    mocks.db.getForcedAccount.mockResolvedValue(account());
    const unsupported = deps({ models: { isSupportedByProvider: () => false, resolveAlias: (m: string) => m } });
    const mismatch = await validateForcedAccount(unsupported, "u1", validation(), "a1", { mode: "all", accounts: [] });
    assert.equal((mismatch as { code: string }).code, "provider_account_model_mismatch");

    const providerMismatch = await validateForcedAccount(deps(), "u1", validation({ provider: "other" }), "a1", { mode: "all", accounts: [] });
    assert.equal((providerMismatch as { code: string }).code, "provider_account_provider_mismatch");

    mocks.accounts.canAccountUseModel.mockReturnValueOnce(false);
    const tierMismatch = await validateForcedAccount(deps(), "u1", validation(), "a1", { mode: "all", accounts: [] });
    assert.equal((tierMismatch as { code: string }).code, "provider_account_tier_mismatch");
  });

  it("accepts valid and custom accounts", async () => {
    mocks.db.getForcedAccount.mockResolvedValue(account());
    const valid = await validateForcedAccount(deps(), "u1", validation(), "a1", { mode: "all", accounts: [] });
    assert.equal((valid as ProviderAccount).id, "a1");

    mocks.db.getCustomProvider.mockResolvedValue({ id: "cp1" });
    mocks.db.listCustomProviderModels.mockResolvedValue([{ modelId: "m" }]);
    const custom = await validateForcedAccount(deps(), "u1", validation(), "a1", { mode: "all", accounts: [] });
    assert.equal((custom as ProviderAccount).id, "a1");

    const allowedInactive = await validateForcedAccount(
      deps(),
      "u1",
      validation(),
      "a1",
      { mode: "all", accounts: [] },
      true
    );
    assert.equal((allowedInactive as ProviderAccount).id, "a1");
  });

  it("rejects synthetic accounts that cannot use the model", async () => {
    const providerAuthless = deps({
      providers: { has: () => false, isAuthless: (id: string) => id === "opencode" },
      models: { isSupportedByProvider: () => false, resolveAlias: (m: string) => m },
    });
    const result = await validateForcedAccount(providerAuthless, "u1", validation(), "opencode", { mode: "all", accounts: [] });
    assert.equal((result as { code: string }).code, "provider_account_model_mismatch");
  });
});

describe("executeWithAccountRotation", () => {
  it("returns a forced successful attempt", async () => {
    const forced = account();
    const result = await executeWithAccountRotation(deps(), cfg(), parsed(), authResult(), validation(), forced, Date.now(), "s");
    assert.equal((result as { account: ProviderAccount }).account.id, "a1");
    assert.equal((result as { response: Response }).response.status, 200);
    assert.equal(mocks.health.bumpAccountRequestCountDeferred.mock.calls.length > 0, true);
  });

  it("returns the failure for forced errors", async () => {
    mocks.creds.makeProviderRequest.mockRejectedValueOnce(new Error("boom"));
    const result = await executeWithAccountRotation(deps(), cfg(), parsed(), authResult(), validation(), account(), Date.now(), "s");
    assert.equal((result as { status: number }).status, 500);
    assert.equal((result as { accountId: string }).accountId, "a1");
  });

  it("rotates until a request succeeds", async () => {
    mocks.accounts.getNextAvailableAccount
      .mockResolvedValueOnce({ account: account({ id: "a1" }), configured: true })
      .mockResolvedValueOnce({ account: account({ id: "a2" }), configured: true });
    mocks.creds.makeProviderRequest
      .mockResolvedValueOnce(new Response("bad", { status: 500 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const result = await executeWithAccountRotation(deps(), cfg(), parsed(), authResult(), validation(), null, Date.now(), "s");
    assert.equal((result as { account: ProviderAccount }).account.id, "a2");
    assert.equal((result as { rotationFailures: unknown[] }).rotationFailures.length, 1);
  });

  it("reports missing and unavailable accounts", async () => {
    const none = await executeWithAccountRotation(deps(), cfg(), parsed(), authResult(), validation(), null, Date.now(), "s");
    assert.equal((none as { status: number }).status, 404);

    mocks.accounts.getNextAvailableAccount.mockResolvedValueOnce({ account: null, configured: true });
    const configured = await executeWithAccountRotation(deps(), cfg(), parsed(), authResult(), validation(), null, Date.now(), "s");
    assert.equal((configured as { status: number }).status, 503);
  });

  it("fell back across providers on bad requests", async () => {
    mocks.accounts.getNextAvailableAccount
      .mockResolvedValueOnce({ account: account({ id: "a1" }), configured: true })
      .mockResolvedValueOnce({ account: null, configured: true });
    mocks.creds.makeProviderRequest.mockResolvedValueOnce(new Response("bad", { status: 400 }));
    const result = await executeWithAccountRotation(deps(), cfg(), parsed(), authResult(), validation(), null, Date.now(), "s");
    assert.equal((result as { status: number }).status, 400);
  });

  it("reserves and refunds roaming points", async () => {
    const roamingAuth = authResult({ roamingEnabled: true });
    mocks.accounts.getNextSharedAccount.mockResolvedValueOnce({ account: account({ id: "s1" }), configured: false });
    const insufficient = await executeWithAccountRotation(deps(), cfg(), parsed(), roamingAuth, validation(), null, Date.now(), "s");
    assert.equal((insufficient as { code: string }).code, "insufficient_points");

    mocks.accounts.getNextSharedAccount.mockResolvedValueOnce({ account: account({ id: "s1" }), configured: false });
    mocks.points.reserveRoamingPoint.mockResolvedValueOnce({ userId: "u1", model: "m", amount: 1, debitId: "d1" });
    const result = await executeWithAccountRotation(deps(), cfg(), parsed(), roamingAuth, validation(), null, Date.now(), "s");
    assert.equal((result as { roaming: unknown }).roaming !== null, true);
  });

  it("strips images for non-vision models", async () => {
    const d = deps({ models: { isVisionModel: () => false, resolveAlias: (m: string) => m, providersForModel: () => ["kiro"], isSupportedByProvider: () => true, lookupKeys: () => ["m"] } });
    mocks.accounts.getNextAvailableAccount.mockResolvedValueOnce({ account: account({ id: "a1" }), configured: true });
    const c = { ...cfg(), build: () => ({ messages: [{ content: [{ type: "image_url", image_url: { url: "x" } }] }] }) } as unknown as EndpointAdapter;
    await executeWithAccountRotation(d, c, parsed(), authResult(), validation({ vision: null }), null, Date.now(), "s");
    const payload = mocks.creds.makeProviderRequest.mock.calls[0]![2] as { messages: Array<{ content: unknown }> };
    assert.deepEqual(payload.messages[0]!.content, []);

    mocks.accounts.getNextAvailableAccount.mockResolvedValueOnce({ account: account({ id: "a1" }), configured: true });
    await executeWithAccountRotation(d, c, parsed(), authResult(), validation({ vision: false }), null, Date.now(), "s");
    const noVision = mocks.creds.makeProviderRequest.mock.calls.at(-1)![2] as { messages: Array<{ content: unknown }> };
    assert.deepEqual(noVision.messages[0]!.content, []);
  });

  it("captures upstream start timestamps", async () => {
    mocks.accounts.getNextAvailableAccount.mockResolvedValueOnce({ account: account({ id: "a1" }), configured: true });
    mocks.creds.makeProviderRequest.mockImplementationOnce(async (_d: unknown, _a: unknown, _p: unknown, _s: unknown, onStart: () => void) => {
      onStart();
      return new Response("ok", { status: 200 });
    });
    const result = (await executeWithAccountRotation(deps(), cfg(), parsed(), authResult(), validation(), null, Date.now(), "s")) as AttemptResult;
    assert.equal(result.upstreamFirstResponseMs > 0, true);
  });

  it("refunds roaming points on thrown errors and error responses", async () => {
    const roamingAuth = authResult({ roamingEnabled: true });
    mocks.accounts.getNextSharedAccount
      .mockResolvedValueOnce({ account: account({ id: "s1" }), configured: false })
      .mockResolvedValueOnce({ account: null, configured: false });
    mocks.points.reserveRoamingPoint.mockResolvedValueOnce({ userId: "u1", model: "m", amount: 1, debitId: "d1" });
    mocks.creds.makeProviderRequest.mockRejectedValueOnce(new Error("boom"));
    const thrown = await executeWithAccountRotation(deps(), cfg(), parsed(), roamingAuth, validation(), null, Date.now(), "s");
    assert.equal((thrown as { status: number }).status, 500);
    assert.equal(mocks.points.refundRoamingPoint.mock.calls.length >= 1, true);

    const roamingAuth2 = authResult({ roamingEnabled: true });
    mocks.accounts.getNextSharedAccount
      .mockResolvedValueOnce({ account: account({ id: "s2" }), configured: false })
      .mockResolvedValueOnce({ account: null, configured: false });
    mocks.points.reserveRoamingPoint.mockResolvedValueOnce({ userId: "u1", model: "m", amount: 1, debitId: "d2" });
    mocks.creds.makeProviderRequest.mockResolvedValueOnce(new Response("bad", { status: 500 }));
    await executeWithAccountRotation(deps(), cfg(), parsed(), roamingAuth2, validation(), null, Date.now(), "s");
    assert.equal(mocks.points.refundRoamingPoint.mock.calls.length >= 2, true);
  });

  it("defers antigravity exhaustion failures", async () => {
    mocks.accounts.getNextAvailableAccount
      .mockResolvedValueOnce({ account: account({ id: "a1", provider: "antigravity" }), configured: true })
      .mockResolvedValueOnce({ account: null, configured: false });
    mocks.creds.makeProviderRequest.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { status: "resource_exhausted" } }), { status: 429 })
    );
    await executeWithAccountRotation(deps(), cfg(), parsed(), authResult(), validation(), null, Date.now(), "s");
    assert.equal(mocks.health.logAccountError.mock.calls.length >= 1, true);
    assert.equal(mocks.health.markAccountFailed.mock.calls.length >= 1, true);
  });

  it("marks codex usage limits", async () => {
    mocks.accounts.getNextAvailableAccount
      .mockResolvedValueOnce({ account: account({ id: "a1", provider: "codex" }), configured: true })
      .mockResolvedValueOnce({ account: null, configured: false });
    mocks.creds.makeProviderRequest.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { type: "usage_limit_reached", resets_in_seconds: 60 } }), { status: 429 })
    );
    await executeWithAccountRotation(deps(), cfg(), parsed(), authResult(), validation(), null, Date.now(), "s");
    assert.equal(mocks.health.markAccountUsageLimited.mock.calls.length >= 1, true);
  });

  it("returns non-rotatable failures", async () => {
    mocks.accounts.getNextAvailableAccount.mockResolvedValueOnce({ account: account({ id: "a1" }), configured: true });
    mocks.creds.makeProviderRequest.mockResolvedValueOnce(new Response("bad", { status: 422 }));
    const result = await executeWithAccountRotation(deps(), cfg(), parsed(), authResult(), validation(), null, Date.now(), "s");
    assert.equal((result as { status: number }).status, 422);
  });
});
