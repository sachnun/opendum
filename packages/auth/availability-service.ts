import { Effect } from "effect";
import type { Registry } from "@opendum/models/runtime";
import { disabledModelsKey, type OpendumRedis } from "@opendum/core/redis";
import { ignoringErrors, tryAsync } from "@opendum/core/best-effort";
import {
  listActiveAccountTiers,
  listDisabledModelsByAccounts,
  listDisabledModelsByUser,
  listSharedAccounts,
} from "@opendum/database/queries";
import type { AccessPolicy } from "./access-policy.js";
import { AUTHLESS_PROVIDER_NAMES } from "./authless.js";
import type { CustomModelService } from "./custom-model-service.js";
import { normalizeDisabledModelList } from "./normalize.js";
import { type AccountModelAvailability, emptyAvailability } from "./types.js";

const DISABLED_MODELS_TTL_SECONDS = 60;

export type AvailabilityQueries = {
  listActiveAccountTiers: typeof listActiveAccountTiers;
  listDisabledModelsByAccounts: typeof listDisabledModelsByAccounts;
  listDisabledModelsByUser: typeof listDisabledModelsByUser;
  listSharedAccounts: typeof listSharedAccounts;
};

const defaultQueries: AvailabilityQueries = {
  listActiveAccountTiers,
  listDisabledModelsByAccounts,
  listDisabledModelsByUser,
  listSharedAccounts,
};

export type AvailabilityServiceOptions = {
  registry: Registry;
  redis: OpendumRedis;
  customModels: CustomModelService;
  accessPolicy: AccessPolicy;
  queries?: AvailabilityQueries;
};

export class AvailabilityService {
  private readonly registry: Registry;
  private readonly redis: OpendumRedis;
  private readonly customModels: CustomModelService;
  private readonly accessPolicy: AccessPolicy;
  private readonly queries: AvailabilityQueries;

  constructor(options: AvailabilityServiceOptions) {
    this.registry = options.registry;
    this.redis = options.redis;
    this.customModels = options.customModels;
    this.accessPolicy = options.accessPolicy;
    this.queries = options.queries ?? defaultQueries;
  }

  disabledModelSetForUser(userId: string): Effect.Effect<Set<string>> {
    return Effect.gen({ self: this }, function* () {
      const cached = yield* this.getCachedDisabledModels(userId);
      if (cached) return new Set(cached);
      const rows = yield* Effect.promise(() => this.queries.listDisabledModelsByUser(userId));
      const modelList = normalizeDisabledModelList(this.registry, rows.map((row) => row.trim()));
      yield* this.setCachedDisabledModels(userId, modelList);
      return new Set(modelList);
    });
  }

  isModelDisabledForUser(userId: string, model: string): Effect.Effect<boolean> {
    return Effect.gen({ self: this }, function* () {
      const set = yield* this.disabledModelSetForUser(userId);
      return set.has(this.registry.resolveAlias(model));
    });
  }

  getAccountModelAvailabilityWithSharing(
    userId: string,
    includeShared: boolean,
    options: { includeInactiveAccounts?: boolean } = {}
  ): Effect.Effect<AccountModelAvailability> {
    return Effect.gen({ self: this }, function* () {
      const availability = emptyAvailability();

      for (const provider of AUTHLESS_PROVIDER_NAMES) {
        availability.activeProviders.add(provider);
        availability.accountCountByProvider.set(provider, 1);
        availability.activeAccountIdsByProvider.set(provider, [provider]);
      }
      for (const [provider, models] of this.registry.authlessProviderModels()) {
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
        const set = availability.authlessProviderModels.get(provider) ?? new Set<string>();
        for (const model of models) set.add(model);
        availability.authlessProviderModels.set(provider, set);
      }

      const now = new Date();
      const accounts = yield* Effect.promise(() =>
        this.queries.listActiveAccountTiers(userId, now, options.includeInactiveAccounts === true)
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
        const disabledRows = yield* Effect.promise(() => this.queries.listDisabledModelsByAccounts(accountIds));
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

      const { aliased, standalone } = yield* this.customModels.customProviderModelSets(userId);
      for (const [slug, models] of aliased) {
        if ((availability.accountCountByProvider.get(slug) ?? 0) === 0) continue;
        availability.customProviderModels.set(slug, models);
      }
      for (const [slug, models] of standalone) {
        availability.customProviderStandaloneModels.set(slug, models);
      }

      if (!includeShared) return availability;

      const sharedAccounts = yield* Effect.promise(() => this.queries.listSharedAccounts(userId, now));
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
        const disabledRows = yield* Effect.promise(() =>
          this.queries.listDisabledModelsByAccounts(sharedAccountIds)
        );
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

  usableModelCandidates(
    userId: string,
    provider: string | null,
    mode: string,
    modelSet: Set<string>,
    roamingEnabled: boolean
  ): Effect.Effect<string[]> {
    return Effect.gen({ self: this }, function* () {
      const candidates = provider ? this.registry.modelsForProvider(provider) : this.registry.allModels();
      const disabledSet = yield* this.disabledModelSetForUser(userId);
      const availability = yield* this.getAccountModelAvailabilityWithSharing(userId, roamingEnabled);
      const values: string[] = [];
      for (const candidate of candidates) {
        const canonical = this.registry.resolveAlias(candidate);
        if (disabledSet.has(canonical)) continue;
        const usable =
          this.accessPolicy.isModelUsableByAccounts(canonical, availability) ||
          (roamingEnabled && this.accessPolicy.isModelUsableBySharedAccounts(canonical, availability));
        if (!usable) continue;
        if (mode === "whitelist" && !modelSet.has(canonical)) continue;
        if (mode === "blacklist" && modelSet.has(canonical)) continue;
        values.push(candidate);
      }
      return values;
    });
  }

  private getCachedDisabledModels(userId: string): Effect.Effect<string[] | null> {
    return tryAsync(async () => {
      const raw = await this.redis.get(disabledModelsKey(userId));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { models?: string[] };
      return normalizeDisabledModelList(this.registry, parsed.models ?? []);
    }, null);
  }

  private setCachedDisabledModels(userId: string, models: string[]): Effect.Effect<void> {
    return ignoringErrors(() =>
      this.redis.set(
        disabledModelsKey(userId),
        JSON.stringify({ models: normalizeDisabledModelList(this.registry, models) }),
        { EX: DISABLED_MODELS_TTL_SECONDS }
      )
    );
  }
}
