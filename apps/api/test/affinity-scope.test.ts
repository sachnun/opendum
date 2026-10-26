import { describe, expect, it, mock } from "bun:test";
import { Effect } from "effect";
import {
  AccountAffinity,
  OWN_ACCOUNT_SCOPE,
  SHARED_ACCOUNT_SCOPE,
  affinityKey,
  type OpendumRedis,
} from "@opendum/core/redis";
import type { ProviderAccount, ProviderRegistry } from "@opendum/providers";
import type { Registry } from "@opendum/models/runtime";
import type { Health } from "../core/health.js";
import type { ProviderPerformance } from "../core/provider-performance.js";
import { Rotation } from "../core/rotation.js";
import { fakes } from "./fakes.js";

function memoryRedis(fail = false): { redis: OpendumRedis; store: Map<string, string> } {
  const store = new Map<string, string>();
  const redis = {
    get: async (key: string) => {
      if (fail) throw new Error("redis unavailable");
      return store.get(key) ?? null;
    },
    set: async (key: string, value: string) => {
      if (fail) throw new Error("redis unavailable");
      store.set(key, value);
      return "OK";
    },
  } as unknown as OpendumRedis;
  return { redis, store };
}

function sharedAccount(extra: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id: "shared-1",
    userId: "owner",
    provider: "workbuddy",
    status: "active",
    lastUsedAt: null,
    ...extra,
  } as unknown as ProviderAccount;
}

describe("AccountAffinity scopes", () => {
  it("keeps own and shared affinities apart", async () => {
    const { redis, store } = memoryRedis();
    const affinity = new AccountAffinity(redis, ["workbuddy"]);

    await Effect.runPromise(affinity.store("user-1", "own-1", OWN_ACCOUNT_SCOPE));
    await Effect.runPromise(affinity.store("user-1", "shared-1", SHARED_ACCOUNT_SCOPE));

    expect(await Effect.runPromise(affinity.lookup("user-1", OWN_ACCOUNT_SCOPE))).toBe("own-1");
    expect(await Effect.runPromise(affinity.lookup("user-1", SHARED_ACCOUNT_SCOPE))).toBe("shared-1");
    expect(store.has(affinityKey("user-1", SHARED_ACCOUNT_SCOPE))).toBe(true);
    expect(affinityKey("user-1", SHARED_ACCOUNT_SCOPE)).not.toBe(
      affinityKey("user-1", OWN_ACCOUNT_SCOPE)
    );
  });

  it("keeps the legacy key for the own scope", () => {
    expect(affinityKey("user-1", OWN_ACCOUNT_SCOPE)).toBe("opendum:account-affinity:user-1");
  });

  it("degrades to an empty affinity when redis fails", async () => {
    const affinity = new AccountAffinity(memoryRedis(true).redis, ["workbuddy"]);

    expect(await Effect.runPromise(affinity.lookup("user-1", OWN_ACCOUNT_SCOPE))).toBe("");
    await Effect.runPromise(affinity.store("user-1", "acc-1", OWN_ACCOUNT_SCOPE));
  });
});

describe("Rotation shared affinity", () => {
  function rotation(affinity: AccountAffinity, accounts: ProviderAccount[], health: Partial<Health>): Rotation {
    const repositories = fakes();
    repositories.accounts.sharedAccounts = mock(() => Effect.succeed(accounts as never));
    repositories.accounts.disabledIds = mock(() => Effect.succeed([]));
    return new Rotation({
      accounts: repositories.accounts,
      modelHealth: repositories.health,
      customProviders: repositories.customProviders,
      models: {
        providers: () => ["workbuddy"],
        lookupKeys: () => [],
        resolveAlias: (model: string) => model,
        rule: () => null,
      } as unknown as Registry,
      providers: { isAuthless: () => false } as unknown as ProviderRegistry,
      health: health as Health,
      performance: { scoresForModel: () => Effect.succeed(new Map()) } as unknown as ProviderPerformance,
      affinity,
    });
  }

  it("prefers the sticky shared account over the least recently used one", async () => {
    const { redis } = memoryRedis();
    const affinity = new AccountAffinity(redis, ["workbuddy"]);
    await Effect.runPromise(affinity.store("user-1", "shared-2", SHARED_ACCOUNT_SCOPE));
    const seen: string[] = [];
    const engine = rotation(
      affinity,
      [sharedAccount({ id: "shared-1" }), sharedAccount({ id: "shared-2" })],
      {
        refresh: () => Effect.succeed(false),
        bumpRequest: (id: string) => seen.push(id),
      }
    );

    const selection = await Effect.runPromise(
      engine.nextAccount(
        { userId: "user-1", accountAccessMode: "all", accountAccessList: [] } as never,
        { model: "m", provider: null } as never,
        [],
        [],
        [],
        true
      )
    );

    expect(selection.account?.id).toBe("shared-2");
    expect(seen).toEqual(["shared-2"]);
  });

  it("stores the shared account after a successful pick", async () => {
    const { redis } = memoryRedis();
    const affinity = new AccountAffinity(redis, ["workbuddy"]);
    const engine = rotation(affinity, [sharedAccount({ id: "shared-7" })], {
      refresh: () => Effect.succeed(false),
      bumpRequest: () => undefined,
    });

    await Effect.runPromise(
      engine.nextAccount(
        { userId: "user-1", accountAccessMode: "all", accountAccessList: [] } as never,
        { model: "m", provider: null } as never,
        [],
        [],
        [],
        true
      )
    );

    expect(await Effect.runPromise(affinity.lookup("user-1", SHARED_ACCOUNT_SCOPE))).toBe("shared-7");
    expect(await Effect.runPromise(affinity.lookup("user-1", OWN_ACCOUNT_SCOPE))).toBe("");
  });

  it("moves on when the sticky shared account is cooling down", async () => {
    const { redis } = memoryRedis();
    const affinity = new AccountAffinity(redis, ["workbuddy"]);
    await Effect.runPromise(affinity.store("user-1", "shared-1", SHARED_ACCOUNT_SCOPE));
    const engine = rotation(
      affinity,
      [sharedAccount({ id: "shared-1" }), sharedAccount({ id: "shared-2" })],
      {
        refresh: (id: string) => Effect.succeed(id === "shared-1"),
        bumpRequest: () => undefined,
      }
    );

    const selection = await Effect.runPromise(
      engine.nextAccount(
        { userId: "user-1", accountAccessMode: "all", accountAccessList: [] } as never,
        { model: "m", provider: null } as never,
        [],
        [],
        [],
        true
      )
    );

    expect(selection.account?.id).toBe("shared-2");
    expect(await Effect.runPromise(affinity.lookup("user-1", SHARED_ACCOUNT_SCOPE))).toBe("shared-2");
  });
});
