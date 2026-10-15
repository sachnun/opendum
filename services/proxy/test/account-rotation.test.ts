import { describe, expect, it } from "bun:test";
import type { SessionAffinity } from "@opendum/core/redis";
import type { ProviderAccount, ProviderRegistry } from "@opendum/providers";
import type { Registry } from "@opendum/models/runtime";
import type { AccountHealthService } from "../core/account-health.js";
import type { ProviderPerformance } from "../core/provider-performance.js";
import { AccountRotationService } from "../core/account-rotation.js";
import { createFakeRepositories } from "./fake-repositories.js";

const repositories = createFakeRepositories();

function account(extra: Partial<ProviderAccount> = {}): ProviderAccount {
  return { id: "acc-1", userId: "u", provider: "openai", status: "active", lastUsedAt: null, ...extra } as unknown as ProviderAccount;
}

function rotation(models: Partial<Registry>): InstanceType<typeof AccountRotationService> {
  return new AccountRotationService({
    accounts: repositories.accounts,
    modelHealth: repositories.health,
    customProviders: repositories.customProviders,
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
