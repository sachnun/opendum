import { describe, expect, it, mock } from "bun:test";
import type { Database } from "@opendum/database";
import type { SessionAffinity } from "@opendum/core/redis";
import type { ProviderAccount, ProviderRegistry } from "@opendum/providers";
import type { Registry } from "@opendum/models/runtime";
import type { AccountHealthService } from "../core/account-health.js";
import type { ProviderPerformance } from "../core/provider-performance.js";
import { createDatabaseQueryMocks } from "./database-mock.js";

const db = createDatabaseQueryMocks();
mock.module("@opendum/database/queries", () => db);

const { AccountRotationService } = await import("../core/account-rotation.js");

function account(extra: Partial<ProviderAccount> = {}): ProviderAccount {
  return { id: "acc-1", userId: "u", provider: "openai", status: "active", lastUsedAt: null, ...extra } as unknown as ProviderAccount;
}

function rotation(models: Partial<Registry>): InstanceType<typeof AccountRotationService> {
  return new AccountRotationService({
    database: db as unknown as Database,
    models: models as Registry,
    providers: {} as unknown as ProviderRegistry,
    health: {} as unknown as AccountHealthService,
    performance: {} as unknown as ProviderPerformance,
    affinity: {} as unknown as SessionAffinity,
  });
}

describe("AccountRotationService.canAccountUseModel", () => {
  it("allows any account when the provider has no access rule", () => {
    expect(rotation({ providerAccessRule: () => null }).canAccountUseModel(account(), "claude-sonnet")).toBe(true);
  });

  it("allows any tier when the rule does not restrict tiers", () => {
    const models = { providerAccessRule: () => ({ minTier: "free", allowedTiers: [] }) };
    expect(rotation(models).canAccountUseModel(account({ tier: "free" }), "m")).toBe(true);
    expect(rotation(models).canAccountUseModel(account({ tier: "plus" }), "m")).toBe(true);
  });

  it("enforces a minimum tier rule", () => {
    const models = { providerAccessRule: () => ({ minTier: "plus" }) };
    expect(rotation(models).canAccountUseModel(account({ tier: "free" }), "m")).toBe(false);
    expect(rotation(models).canAccountUseModel(account({ tier: "plus" }), "m")).toBe(true);
    expect(rotation(models).canAccountUseModel(account({ tier: "  PLUS " }), "m")).toBe(true);
  });

  it("enforces an allowed-tiers rule", () => {
    const models = { providerAccessRule: () => ({ allowedTiers: ["pro", "pro+"] }) };
    expect(rotation(models).canAccountUseModel(account({ tier: "plus" }), "m")).toBe(false);
    expect(rotation(models).canAccountUseModel(account({ tier: "pro" }), "m")).toBe(true);
  });

  it("falls back to free when the account has no tier", () => {
    const models = { providerAccessRule: () => ({ minTier: "plus" }) };
    expect(rotation(models).canAccountUseModel(account(), "m")).toBe(false);
    expect(rotation(models).canAccountUseModel(account({ tier: "  " }), "m")).toBe(false);
  });
});
