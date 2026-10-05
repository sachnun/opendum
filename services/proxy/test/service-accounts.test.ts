import assert from "node:assert/strict";
import { beforeEach, describe, it, vi } from "vitest";
import type { ProviderAccount } from "@opendum/providers";

const mocks = vi.hoisted(() => ({
  db: {
    getModelHealth: vi.fn(),
    listCustomProviderModels: vi.fn(),
    listCustomProviders: vi.fn(),
    listDisabledAccountIDs: vi.fn(),
    listEligibleAccounts: vi.fn(),
    listSharedEligibleAccounts: vi.fn(),
  },
  health: { bumpAccountRequestCountDeferred: vi.fn(), refreshAccountHealthFromModels: vi.fn() },
}));

vi.mock("@opendum/database/queries", () => mocks.db);
vi.mock("../src/core/service-health.js", () => mocks.health);

import {
  canAccountUseModel,
  getNextAvailableAccount,
  getNextSharedAccount,
} from "../src/core/service-accounts.js";
import type { ProxyDeps } from "../src/core/service-deps.js";

function account(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return { id: "a1", userId: "u1", provider: "kiro", isActive: true, status: "active", ...overrides };
}

function deps(overrides: Record<string, unknown> = {}): ProxyDeps {
  return {
    database: {},
    models: {
      providerAccessRule: () => null,
      resolveAlias: (model: string) => model,
      providersForModel: () => ["kiro"],
      isAuthlessProviderModel: () => false,
      lookupKeys: () => ["m"],
    },
    providers: { isAuthless: () => false },
    affinity: { lookup: vi.fn(async () => null), enabled: vi.fn(() => false), store: vi.fn(async () => undefined) },
    performance: { scoresForModel: vi.fn(async () => new Map()), routingOptions: vi.fn(() => ({ scores: new Map(), bufferRatio: 0 })) },
    ...overrides,
  } as unknown as ProxyDeps;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.db.getModelHealth.mockResolvedValue(null);
  mocks.db.listCustomProviderModels.mockResolvedValue([]);
  mocks.db.listCustomProviders.mockResolvedValue([]);
  mocks.db.listDisabledAccountIDs.mockResolvedValue([]);
  mocks.db.listEligibleAccounts.mockResolvedValue([]);
  mocks.db.listSharedEligibleAccounts.mockResolvedValue([]);
  mocks.health.bumpAccountRequestCountDeferred.mockResolvedValue(undefined);
  mocks.health.refreshAccountHealthFromModels.mockResolvedValue(false);
});

describe("canAccountUseModel", () => {
  it("allows models without access rules", () => {
    assert.equal(canAccountUseModel(deps(), account(), "m"), true);
  });

  it("enforces tier rules", () => {
    const d = deps({
      models: { providerAccessRule: () => ({ minTier: "pro" }), resolveAlias: (m: string) => m, providersForModel: () => ["kiro"], lookupKeys: () => ["m"] },
    });
    assert.equal(canAccountUseModel(d, account({ tier: "pro" }), "m"), true);
    assert.equal(canAccountUseModel(d, account({ tier: "free" }), "m"), false);
  });
});

describe("getNextAvailableAccount", () => {
  it("returns synthetic authless accounts", async () => {
    const providerAuthless = deps({ providers: { isAuthless: (provider: string) => provider === "kiro" } });
    const result = await getNextAvailableAccount(providerAuthless, "u1", "m", null, [], [], { mode: "all", accounts: [] }, "s");
    assert.equal(result.account?.id, "kiro");

    const modelAuthless = deps({
      models: { providersForModel: () => ["kiro"], isAuthlessProviderModel: () => true, resolveAlias: (m: string) => m, lookupKeys: () => ["m"] },
    });
    const authless = await getNextAvailableAccount(modelAuthless, "u1", "m", null, [], [], { mode: "all", accounts: [] }, "s");
    assert.equal(authless.account?.id, "authless:kiro");
  });

  it("selects healthy database accounts", async () => {
    const row = { id: "a1", userId: "u1", provider: "kiro", tier: "pro", accountId: null, status: "active", disabledUntil: null, lastUsedAt: null, createdAt: null };
    mocks.db.listEligibleAccounts.mockResolvedValueOnce([row]);
    const result = await getNextAvailableAccount(deps(), "u1", "m", null, [], [], { mode: "all", accounts: [] }, "s");
    assert.equal(result.account?.id, "a1");
    assert.equal(result.configured, true);
  });

  it("excludes synthetic accounts by id, provider and access rules", async () => {
    const providerAuthless = deps({ providers: { isAuthless: (provider: string) => provider === "kiro" } });
    const byId = await getNextAvailableAccount(providerAuthless, "u1", "m", null, ["kiro"], [], { mode: "all", accounts: [] }, "s");
    assert.equal(byId.account, null);

    const byProvider = await getNextAvailableAccount(providerAuthless, "u1", "m", null, [], ["kiro"], { mode: "all", accounts: [] }, "s");
    assert.equal(byProvider.account, null);

    const byAccess = await getNextAvailableAccount(providerAuthless, "u1", "m", null, [], [], { mode: "whitelist", accounts: ["other"] }, "s");
    assert.equal(byAccess.account, null);
  });

  it("filters disabled and unusable accounts", async () => {
    const row = { id: "a1", userId: "u1", provider: "kiro", tier: "pro", accountId: null, status: "active", disabledUntil: null, lastUsedAt: null, createdAt: null };
    mocks.db.listEligibleAccounts.mockResolvedValueOnce([row]);
    mocks.db.listDisabledAccountIDs.mockResolvedValueOnce([{ providerAccountId: "a1", model: "m" }]);
    const disabled = await getNextAvailableAccount(deps(), "u1", "m", null, [], [], { mode: "all", accounts: [] }, "s");
    assert.equal(disabled.account, null);

    const restricted = deps({
      models: { providerAccessRule: () => ({ minTier: "pro" }), resolveAlias: (m: string) => m, providersForModel: () => ["kiro"], isAuthlessProviderModel: () => false, lookupKeys: () => ["m"] },
    });
    mocks.db.listEligibleAccounts.mockResolvedValueOnce([{ ...row, tier: "free" }]);
    const unusable = await getNextAvailableAccount(restricted, "u1", "m", null, [], [], { mode: "all", accounts: [] }, "s");
    assert.equal(unusable.account, null);
  });

  it("skips cooling and degraded accounts", async () => {
    const row = { id: "a1", userId: "u1", provider: "kiro", tier: "pro", accountId: null, status: "active", disabledUntil: null, lastUsedAt: null, createdAt: null };
    mocks.db.listEligibleAccounts.mockResolvedValueOnce([row]);
    mocks.health.refreshAccountHealthFromModels.mockResolvedValueOnce(true);
    const cooling = await getNextAvailableAccount(deps(), "u1", "m", null, [], [], { mode: "all", accounts: [] }, "s");
    assert.equal(cooling.account, null);
    assert.equal(cooling.configured, true);

    mocks.db.listEligibleAccounts.mockResolvedValueOnce([row]);
    mocks.db.getModelHealth.mockResolvedValueOnce({ status: "degraded" });
    const degraded = await getNextAvailableAccount(deps(), "u1", "m", null, [], [], { mode: "all", accounts: [] }, "s");
    assert.equal(degraded.account?.id, "a1");
  });

  it("prefers sticky accounts and stores affinity", async () => {
    const rows = [
      { id: "a1", userId: "u1", provider: "kiro", tier: "pro", accountId: null, status: "active", disabledUntil: null, lastUsedAt: null, createdAt: null },
      { id: "a2", userId: "u1", provider: "kiro", tier: "pro", accountId: null, status: "active", disabledUntil: null, lastUsedAt: null, createdAt: null },
    ];
    mocks.db.listEligibleAccounts.mockResolvedValueOnce(rows);
    const d = deps({
      affinity: { lookup: async () => "a2", enabled: () => true, store: vi.fn(async () => undefined) },
    });
    const result = await getNextAvailableAccount(d, "u1", "m", null, [], [], { mode: "all", accounts: [] }, "s");
    assert.equal(result.account?.id, "a2");
    assert.equal((d.affinity.store as ReturnType<typeof vi.fn>).mock.calls.length, 1);
  });

  it("uses performance routing for global selection", async () => {
    const row = { id: "a1", userId: "u1", provider: "kiro", tier: "pro", accountId: null, status: "active", disabledUntil: null, lastUsedAt: null, createdAt: null };
    mocks.db.listEligibleAccounts.mockResolvedValueOnce([row]);
    const d = deps();
    (d.performance.scoresForModel as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Map([["a1", { score: 1 }]]));
    await getNextAvailableAccount(d, "u1", "m", null, [], [], { mode: "all", accounts: [] }, "s");
    assert.equal((d.performance.routingOptions as unknown as ReturnType<typeof vi.fn>).mock.calls.length, 1);
  });

  it("includes custom provider slugs for aliased models", async () => {
    mocks.db.listCustomProviders.mockResolvedValueOnce([{ id: "cp1", slug: "custom" }]);
    mocks.db.listCustomProviderModels.mockResolvedValueOnce([{ modelId: "alias-x", aliased: true }]);
    const d = deps();
    const result = await getNextAvailableAccount(d, "u1", "alias-x", null, [], [], { mode: "all", accounts: [] }, "s");
    assert.equal(result.account, null);
    assert.equal(result.configured, false);
    const providers = mocks.db.listEligibleAccounts.mock.calls[0]![0] as { providers: string[] };
    assert.deepEqual(providers.providers, ["kiro", "custom"]);
  });
});

describe("getNextSharedAccount", () => {
  it("handles missing providers and rows", async () => {
    assert.deepEqual(await getNextSharedAccount(deps({ models: { providersForModel: () => [] } }), "u1", "m", null, [], []), {
      account: null,
      configured: false,
    });

    const empty = await getNextSharedAccount(deps(), "u1", "m", "kiro", [], []);
    assert.deepEqual(empty, { account: null, configured: false });
  });

  it("returns shared accounts", async () => {
    const row = { id: "s1", userId: "u2", provider: "kiro", tier: "pro", accountId: null, status: "active", disabledUntil: null, lastUsedAt: null, createdAt: null };
    mocks.db.listSharedEligibleAccounts.mockResolvedValueOnce([row]);
    const result = await getNextSharedAccount(deps(), "u1", "m", "kiro", [], []);
    assert.equal(result.account?.id, "s1");
    assert.equal(result.configured, true);
  });

  it("reports configured but no usable shared accounts", async () => {
    const row = { id: "s1", userId: "u2", provider: "kiro", tier: "pro", accountId: null, status: "active", disabledUntil: null, lastUsedAt: null, createdAt: null };
    mocks.db.listSharedEligibleAccounts.mockResolvedValueOnce([row]);
    mocks.db.listDisabledAccountIDs.mockResolvedValueOnce([{ providerAccountId: "s1", model: "m" }]);
    const result = await getNextSharedAccount(deps(), "u1", "m", "kiro", [], []);
    assert.deepEqual(result, { account: null, configured: true });
  });
});
