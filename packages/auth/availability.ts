import { Effect } from "effect";
import type { DatabaseFailure } from "@opendum/database";
import type { Registry } from "@opendum/models/runtime";
import { disabledKey, type OpendumRedis } from "@opendum/core/redis";
import { ignore, tryAsync } from "@opendum/core/best-effort";
import {
  activeTiers,
  disabledByAccounts,
  disabledByUser,
  listSharedAccounts,
} from "@opendum/database/queries";
import type { Policy } from "@opendum/auth/policy";
import { AUTHLESS } from "@opendum/auth/authless";
import type { CustomModels } from "@opendum/auth/custom-models";
import { disabledList } from "@opendum/auth/normalize";
import { type AccountModelAvailability, emptyAvailability } from "@opendum/auth/types";

const DISABLED_TTL = 60;

export type Queries = {
  activeTiers: typeof activeTiers;
  disabledByAccounts: typeof disabledByAccounts;
  disabledByUser: typeof disabledByUser;
  listSharedAccounts: typeof listSharedAccounts;
};

const defaultQueries: Queries = {
  activeTiers,
  disabledByAccounts,
  disabledByUser,
  listSharedAccounts,
};

export type Options = {
  registry: Registry;
  redis: OpendumRedis;
  customModels: CustomModels;
  accessPolicy: Policy;
  queries?: Queries;
};

export class Availability {
  private readonly registry: Registry;
  private readonly redis: OpendumRedis;
  private readonly customModels: CustomModels;
  private readonly accessPolicy: Policy;
  private readonly queries: Queries;

  constructor(options: Options) {
    this.registry = options.registry;
    this.redis = options.redis;
    this.customModels = options.customModels;
    this.accessPolicy = options.accessPolicy;
    this.queries = options.queries ?? defaultQueries;
  }

  disabledModels(userId: string): Effect.Effect<Set<string>, DatabaseFailure> {
    return Effect.gen({ self: this }, function* () {
      const cached = yield* this.cachedDisabled(userId);
      if (cached) return new Set(cached);
      const rows = yield* this.queries.disabledByUser(userId);
      const modelList = disabledList(this.registry, rows.map((row) => row.trim()));
      yield* this.setDisabled(userId, modelList);
      return new Set(modelList);
    });
  }

  isDisabled(userId: string, model: string): Effect.Effect<boolean, DatabaseFailure> {
    return Effect.gen({ self: this }, function* () {
      const set = yield* this.disabledModels(userId);
      return set.has(this.registry.resolveAlias(model));
    });
  }

  availability(
    userId: string,
    includeShared: boolean,
    options: { includeInactiveAccounts?: boolean } = {}
  ): Effect.Effect<AccountModelAvailability, DatabaseFailure> {
    return Effect.gen({ self: this }, function* () {
      const availability = emptyAvailability();

      for (const provider of AUTHLESS) {
        availability.activeProviders.add(provider);
        availability.accountCountByProvider.set(provider, 1);
        availability.activeAccountIdsByProvider.set(provider, [provider]);
      }
      for (const [provider, models] of this.registry.authlessModels()) {
        if (models.length === 0) continue;
        availability.activeProviders.add(provider);
        availability.accountCountByProvider.set(
          provider,
          (availability.accountCountByProvider.get(provider) ?? 0) + 1
        );
        availability.activeAccountIdsByProvider.set(provider, [
          ...(availability.activeAccountIdsByProvider.get(provider) ?? []),
          provider,
        ]);
        const set = availability.authlessModels.get(provider) ?? new Set<string>();
        for (const model of models) set.add(model);
        availability.authlessModels.set(provider, set);
      }

      const now = new Date();
      const accounts = yield* this.queries.activeTiers(
        userId,
        now,
        options.includeInactiveAccounts === true
      );
      const accountProvider = new Map<string, string>();
      const accountIds: string[] = [];
      for (const account of accounts) {
        availability.activeProviders.add(account.provider);
        availability.accountCountByProvider.set(
          account.provider,
          (availability.accountCountByProvider.get(account.provider) ?? 0) + 1
        );
        const list = availability.activeAccountIdsByProvider.get(account.provider) ?? [];
        list.push(account.id);
        availability.activeAccountIdsByProvider.set(account.provider, list);
        accountProvider.set(account.id, account.provider);
        accountIds.push(account.id);
        if (account.tier && account.tier.trim()) {
          availability.accountTierById.set(account.id, account.tier.trim().toLowerCase());
        }
      }

      if (accountIds.length > 0) {
        const disabledRows = yield* this.queries.disabledByAccounts(accountIds);
        for (const row of disabledRows) {
          const provider = accountProvider.get(row.providerAccountId);
          if (!provider) continue;
          const key = `${provider}:${this.registry.resolveAlias(row.model)}`;
          availability.disabledCountByProviderModel.set(
            key,
            (availability.disabledCountByProviderModel.get(key) ?? 0) + 1
          );
        }
      }

      const { aliased, standalone } = yield* this.customModels.modelSets(userId);
      for (const [slug, models] of aliased) {
        if ((availability.accountCountByProvider.get(slug) ?? 0) === 0) continue;
        availability.customProviderModels.set(slug, models);
      }
      for (const [slug, models] of standalone) {
        availability.customProviderStandaloneModels.set(slug, models);
      }

      if (!includeShared) return availability;

      const sharedAccounts = yield* this.queries.listSharedAccounts(userId, now);
      const sharedAccountProvider = new Map<string, string>();
      const sharedAccountIds: string[] = [];
      for (const account of sharedAccounts) {
        availability.sharedAccountCountByProvider.set(
          account.provider,
          (availability.sharedAccountCountByProvider.get(account.provider) ?? 0) + 1
        );
        sharedAccountProvider.set(account.id, account.provider);
        sharedAccountIds.push(account.id);
        if (account.tier && account.tier.trim()) {
          const list = availability.sharedAccountTiersByProvider.get(account.provider) ?? [];
          list.push(account.tier.trim().toLowerCase());
          availability.sharedAccountTiersByProvider.set(account.provider, list);
        }
      }
      if (sharedAccountIds.length > 0) {
        const disabledRows = yield* this.queries.disabledByAccounts(sharedAccountIds);
        for (const row of disabledRows) {
          const provider = sharedAccountProvider.get(row.providerAccountId);
          if (!provider) continue;
          const key = `${provider}:${this.registry.resolveAlias(row.model)}`;
          availability.sharedDisabledCountByProviderModel.set(
            key,
            (availability.sharedDisabledCountByProviderModel.get(key) ?? 0) + 1
          );
        }
      }

      return availability;
    });
  }

  candidates(
    userId: string,
    provider: string | null,
    mode: string,
    modelSet: Set<string>,
    roamingEnabled: boolean
  ): Effect.Effect<string[], DatabaseFailure> {
    return Effect.gen({ self: this }, function* () {
      const candidates = provider ? this.registry.models(provider) : this.registry.allModels();
      const disabledSet = yield* this.disabledModels(userId);
      const availability = yield* this.availability(userId, roamingEnabled);
      const values: string[] = [];
      for (const candidate of candidates) {
        const canonical = this.registry.resolveAlias(candidate);
        if (disabledSet.has(canonical)) continue;
        const usable =
          this.accessPolicy.usable(canonical, availability) ||
          (roamingEnabled && this.accessPolicy.usableShared(canonical, availability));
        if (!usable) continue;
        if (mode === "whitelist" && !modelSet.has(canonical)) continue;
        if (mode === "blacklist" && modelSet.has(canonical)) continue;
        values.push(candidate);
      }
      return values;
    });
  }

  private cachedDisabled(userId: string): Effect.Effect<string[] | null> {
    return tryAsync(async () => {
      const raw = await this.redis.get(disabledKey(userId));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { models?: string[] };
      return disabledList(this.registry, parsed.models ?? []);
    }, null);
  }

  private setDisabled(userId: string, models: string[]): Effect.Effect<void> {
    return ignore(() =>
      this.redis.set(
        disabledKey(userId),
        JSON.stringify({ models: disabledList(this.registry, models) }),
        { EX: DISABLED_TTL }
      )
    );
  }
}
