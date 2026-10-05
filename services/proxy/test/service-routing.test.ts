import assert from "node:assert/strict";
import { beforeEach, describe, it, vi } from "vitest";
import type { ModelValidationResult } from "@opendum/auth";
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
vi.mock("../src/core/service-accounts.ts", () => mocks.accounts);
vi.mock("../src/core/service-credentials.ts", () => mocks.creds);
vi.mock("../src/core/metering/points.ts", () => mocks.points);
vi.mock("../src/core/health/service-health.ts", () => mocks.health);

import {
  modelAccountSelector,
  validateForcedAccount,
} from "../src/core/selection/service-routing.ts";
import type { ProxyDeps } from "../src/core/service-deps.ts";

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

function validation(overrides: Partial<ModelValidationResult> = {}): ModelValidationResult {
  return { valid: true, provider: null, model: "m", alias: "", vision: null, error: "", param: "", code: "", ...overrides };
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
