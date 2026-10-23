import { Effect } from "effect";
import { and, asc, desc, eq, inArray, lte } from "drizzle-orm";

import { db, providerAccount, proxyApiKey, proxyApiKeyRateLimit } from "@opendum/database";
import { fromPromise } from "#web/lib/task.js";
import { internal, notFound } from "#web/errors.js";
import { decrypt, encrypt, generateApiKey, getKeyPreview, hashString } from "#web/lib/encryption.js";
import { getAccountModelAvailability, invalidateApiKeyValidationCache } from "#web/lib/proxy/auth.js";
import { getAuthlessProviderAccounts, isSyntheticAuthlessAccount } from "#web/lib/proxy/authless-providers.js";
import { listCustomProviderModels } from "#web/lib/proxy/custom-providers.js";
import { getAllFamilies, getAllModels, getModelFamily, getProvidersForModel, isModelSupported, resolveModelAlias } from "#web/lib/proxy/models.js";
import { roamingUsagePointsByApiKey } from "#web/lib/roaming-points.js";
import { compareModelEntries } from "@opendum/models/sort";
import { PROVIDER_ACCOUNT_KEYS } from "./account-providers.js";
import { API_KEY_UPDATE_POINT_COST, debitUserPoints } from "./points.js";
import { apiKeyAccessModeSchema, type ApiKeyAccessMode, type CreateApiKeyInput, type UpdateApiKeyAccountAccessInput, type UpdateApiKeyExpirationInput, type UpdateApiKeyModelAccessInput, type UpdateApiKeyNameInput, type UpdateApiKeyRateLimitsInput, type UpdateApiKeyRoamingInput } from "@opendum/providers/contract";

const API_KEY_MIN_LENGTH = 3;
const API_KEY_MAX_LENGTH = 100;
const API_KEY_ALLOWED_PATTERN = /^[A-Za-z0-9_-]+$/;

interface ApiKeyReadOptions {
  expireActiveKeys?: boolean;
}

function modelList(models: string[]): string[] {
  return Array.from(new Set(models.map((model) => resolveModelAlias(model.trim())).filter((model) => model.length > 0))).sort(compareKnownModelIds);
}

const ownedCustomModelIds = Effect.fn("apiKeys.ownedCustomModelIds")(function* (userId: string) {
  const providers = yield* listCustomProviderModels(userId, { includeInactiveAccounts: true });
  const ids = new Set<string>();
  for (const provider of providers) {
    for (const modelId of provider.standaloneModels) ids.add(`${provider.slug}/${modelId}`);
  }
  return ids;
});

function compareKnownModelIds(left: string, right: string): number {
  return compareModelEntries({ id: left, family: getModelFamily(left) }, { id: right, family: getModelFamily(right) });
}

function buildModelAccessModels(models: string[], activeProviders: ReadonlySet<string>): string[] {
  const result: string[] = [];
  for (const model of models) {
    result.push(model);
    for (const provider of [...getProvidersForModel(model)].sort()) {
      if (activeProviders.has(provider)) result.push(`${provider}/${model}`);
    }
  }
  return result;
}

function isKnownModelAccessId(model: string): boolean {
  if (isModelSupported(model)) return true;
  const slash = model.indexOf("/");
  if (slash <= 0) return false;
  const provider = model.slice(0, slash);
  const base = model.slice(slash + 1);
  return isModelSupported(base) && getProvidersForModel(base).includes(provider);
}

const getOwnedApiKey = Effect.fn("apiKeys.getOwnedApiKey")(function* (userId: string, id: string) {
  const rows = yield* fromPromise(
    () =>
      db
        .select()
        .from(proxyApiKey)
        .where(and(eq(proxyApiKey.id, id), eq(proxyApiKey.userId, userId)))
        .limit(1),
    "Failed to load API key"
  );
  return rows[0] ?? null;
});

type OwnedApiKey = NonNullable<
  import("effect").Effect.Success<ReturnType<typeof getOwnedApiKey>>
>;

const withOwnedApiKey = Effect.fn("apiKeys.withOwnedApiKey")(function* <T>(
  userId: string,
  id: string,
  failureMessage: string,
  action: (apiKey: OwnedApiKey) => import("effect").Effect.Effect<T, import("#web/errors.js").ServiceFailure>
) {
  const apiKey = yield* getOwnedApiKey(userId, id);
  if (!apiKey) return yield* notFound("API key not found");
  return yield* action(apiKey);
});

export const getApiKeyOptions = Effect.fn("apiKeys.getOptions")(function* (userId: string) {
  return yield* buildApiKeyOptions(userId).pipe(
    Effect.mapError((failure) => internal("Failed to load API key options", failure.cause ?? failure))
  );
});

const buildApiKeyOptions = Effect.fnUntraced(function* (userId: string) {
  const apiKeys = yield* fromPromise(
    () => db.select({ id: proxyApiKey.id }).from(proxyApiKey).where(eq(proxyApiKey.userId, userId)),
    "Failed to load API key options"
  );
  const apiKeyIds = apiKeys.map((key) => key.id);
  const rateLimitRows = apiKeyIds.length > 0
    ? yield* fromPromise(
        () =>
          db
            .select({ apiKeyId: proxyApiKeyRateLimit.apiKeyId, target: proxyApiKeyRateLimit.target, targetType: proxyApiKeyRateLimit.targetType, perMinute: proxyApiKeyRateLimit.perMinute, perHour: proxyApiKeyRateLimit.perHour, perDay: proxyApiKeyRateLimit.perDay })
            .from(proxyApiKeyRateLimit)
            .where(inArray(proxyApiKeyRateLimit.apiKeyId, apiKeyIds)),
        "Failed to load API key options"
      )
    : [];
  const providerAccounts = yield* fromPromise(
    () =>
      db
        .select({ id: providerAccount.id, provider: providerAccount.provider, name: providerAccount.name, email: providerAccount.email })
        .from(providerAccount)
        .where(and(eq(providerAccount.userId, userId), inArray(providerAccount.provider, PROVIDER_ACCOUNT_KEYS)))
        .orderBy(asc(providerAccount.provider), asc(providerAccount.name)),
    "Failed to load provider accounts"
  );

  {
    const customModelIds = yield* ownedCustomModelIds(userId);
    const availableModels = [...getAllModels(), ...customModelIds].sort(compareKnownModelIds);
    const availability = yield* getAccountModelAvailability(userId);
    const modelAccessModels = buildModelAccessModels(availableModels, availability.activeProviders);
    const availableFamilies = getAllFamilies();
    const authlessProviderAccounts = getAuthlessProviderAccounts().map(({ disabledModels: _disabledModels, ...account }) => account);

    const rateLimitsByKeyId = rateLimitRows.reduce<Record<string, Array<{ target: string; targetType: "model" | "family"; perMinute: number | null; perHour: number | null; perDay: number | null }>>>((acc, row) => {
      acc[row.apiKeyId] = [
        ...(acc[row.apiKeyId] ?? []),
        { target: row.target, targetType: row.targetType === "family" ? "family" : "model", perMinute: row.perMinute, perHour: row.perHour, perDay: row.perDay },
      ];
      return acc;
    }, {});

    return {
      availableModels,
      modelAccessModels,
      availableFamilies,
      providerAccounts: [
        ...authlessProviderAccounts,
        ...providerAccounts,
      ],
      rateLimitsByKeyId,
    };
  }
});

export const listApiKeys = Effect.fn("apiKeys.list")(function* (
  userId: string,
  options: ApiKeyReadOptions = {}
) {
  return yield* listApiKeysInner(userId, options).pipe(
    Effect.mapError((failure) => internal("Failed to list API keys", failure.cause ?? failure))
  );
});

const listApiKeysInner = Effect.fnUntraced(function* (
  userId: string,
  options: ApiKeyReadOptions = {}
) {
  if (options.expireActiveKeys !== false) {
    yield* fromPromise(
      () =>
        db
          .update(proxyApiKey)
          .set({ isActive: false })
          .where(and(eq(proxyApiKey.userId, userId), eq(proxyApiKey.isActive, true), lte(proxyApiKey.expiresAt, new Date()))),
      "Failed to list API keys"
    );
  }

  {
    const apiKeys = yield* fromPromise(
      () => db
      .select({
        id: proxyApiKey.id,
        name: proxyApiKey.name,
        keyPreview: proxyApiKey.keyPreview,
        encryptedKey: proxyApiKey.encryptedKey,
        isActive: proxyApiKey.isActive,
        createdAt: proxyApiKey.createdAt,
        expiresAt: proxyApiKey.expiresAt,
        lastUsedAt: proxyApiKey.lastUsedAt,
        modelAccessMode: proxyApiKey.modelAccessMode,
        modelAccessList: proxyApiKey.modelAccessList,
        accountAccessMode: proxyApiKey.accountAccessMode,
        accountAccessList: proxyApiKey.accountAccessList,
        roamingEnabled: proxyApiKey.roamingEnabled,
      })
      .from(proxyApiKey)
      .where(eq(proxyApiKey.userId, userId))
      .orderBy(desc(proxyApiKey.createdAt)),
      "Failed to list API keys"
    );
    const apiKeyIds = apiKeys.map((apiKey) => apiKey.id);
    const roamingPointsByKeyId = yield* roamingUsagePointsByApiKey(userId, apiKeyIds);

    return apiKeys.map(({ encryptedKey, ...apiKey }) => ({
      ...apiKey,
      keyPreview: encryptedKey ? getKeyPreview(decrypt(encryptedKey)) : apiKey.keyPreview,
      roamingPointsUsed: roamingPointsByKeyId.get(apiKey.id) ?? 0,
    }));
  }
});

export const createApiKey = Effect.fn("apiKeys.create")(function* (
  userId: string,
  input: CreateApiKeyInput
) {
  return yield* createApiKeyInner(userId, input).pipe(
    Effect.catch((failure: { message: string }) =>
      Effect.succeed({ success: false as const, error: failure.message })
    )
  );
});

const createApiKeyInner = Effect.fnUntraced(function* (
  userId: string,
  input: CreateApiKeyInput
) {
  const key = generateApiKey();
  const name = input?.name?.trim() || null;
  const rows = yield* fromPromise(
    () =>
      db
        .insert(proxyApiKey)
        .values({ userId, keyHash: hashString(key), keyPreview: getKeyPreview(key), encryptedKey: encrypt(key), name, expiresAt: input?.expiresAt ?? null })
        .returning(),
    "Failed to create API key"
  );
  const apiKey = rows[0];
  if (!apiKey) return yield* internal("Failed to create API key");
  return { success: true as const, data: { id: apiKey.id, key, keyPreview: apiKey.keyPreview, name: apiKey.name, expiresAt: apiKey.expiresAt } };
});

const failWith = (message: string) => Effect.succeed({ success: false as const, error: message });

export const toggleApiKey = Effect.fn("apiKeys.toggle")(function* (userId: string, id: string) {
  return yield* withOwnedApiKey(userId, id, "Failed to toggle API key", (apiKey) =>
    Effect.gen(function* () {
      const isExpired = apiKey.expiresAt != null && apiKey.expiresAt <= new Date();
      const isActive = !(apiKey.isActive && !isExpired);
      const expiresAt = isActive && isExpired ? null : apiKey.expiresAt;
      yield* fromPromise(
        () => db.update(proxyApiKey).set({ isActive, expiresAt }).where(eq(proxyApiKey.id, id)),
        "Failed to toggle API key"
      );
      yield* invalidateApiKeyValidationCache(apiKey.keyHash, apiKey.id);
      return { success: true as const, data: { id, isActive, expiresAt } };
    })
  ).pipe(Effect.catch(() => failWith("Failed to toggle API key")));
});

export const deleteApiKey = Effect.fn("apiKeys.delete")(function* (userId: string, id: string) {
  return yield* withOwnedApiKey(userId, id, "Failed to delete API key", (apiKey) =>
    Effect.gen(function* () {
      yield* fromPromise(
        () => db.delete(proxyApiKey).where(eq(proxyApiKey.id, id)),
        "Failed to delete API key"
      );
      yield* invalidateApiKeyValidationCache(apiKey.keyHash, apiKey.id);
      return { success: true as const, data: undefined };
    })
  ).pipe(Effect.catch(() => failWith("Failed to delete API key")));
});

export const revealApiKey = Effect.fn("apiKeys.reveal")(function* (userId: string, id: string) {
  return yield* withOwnedApiKey<string>(userId, id, "Failed to reveal API key", (apiKey) =>
    apiKey.encryptedKey
      ? Effect.succeed(decrypt(apiKey.encryptedKey))
      : Effect.fail(notFound("This API key was created before the reveal feature. Please generate a new key."))
  ).pipe(
    Effect.map((key) => ({ success: true as const, data: { key } })),
    Effect.catch((failure) => failWith(failure.message))
  );
});

export const updateApiKeyName = Effect.fn("apiKeys.updateName")(function* (
  userId: string,
  input: UpdateApiKeyNameInput
) {
  return yield* withOwnedApiKey(userId, input.id, "Failed to update API key", (apiKey) =>
    Effect.gen(function* () {
      const normalizedKey = input.key === undefined ? undefined : input.key.trim();
      const patch: Partial<typeof proxyApiKey.$inferInsert> = { name: input.name.trim() || null };
      let shouldChargeApiKeyUpdate = false;

      if (normalizedKey !== undefined) {
        if (normalizedKey.length < API_KEY_MIN_LENGTH) {
          return yield* failWith(`API key must be at least ${API_KEY_MIN_LENGTH} characters`);
        }
        if (normalizedKey.length > API_KEY_MAX_LENGTH) {
          return yield* failWith(`API key must be at most ${API_KEY_MAX_LENGTH} characters`);
        }
        if (!API_KEY_ALLOWED_PATTERN.test(normalizedKey)) {
          return yield* failWith("API key can only contain letters, numbers, hyphen, and underscore");
        }
        const keyHash = hashString(normalizedKey);
        const existing = yield* fromPromise(
          () => db.select({ id: proxyApiKey.id }).from(proxyApiKey).where(eq(proxyApiKey.keyHash, keyHash)).limit(1),
          "Failed to update API key"
        );
        if (existing[0] && existing[0].id !== apiKey.id) {
          return yield* failWith("Unable to update API key");
        }
        patch.keyHash = keyHash;
        patch.keyPreview = getKeyPreview(normalizedKey);
        patch.encryptedKey = encrypt(normalizedKey);
        shouldChargeApiKeyUpdate = keyHash !== apiKey.keyHash;
      }

      const updated = yield* fromPromise(
        () =>
          db.transaction(async (tx) => {
            if (shouldChargeApiKeyUpdate) {
              const debit = await Effect.runPromise(
                debitUserPoints(tx, userId, API_KEY_UPDATE_POINT_COST, "api_key_update")
              );
              if (!debit.success) return { insufficientPoints: true, balance: debit.balance } as const;
            }

            const rows = await tx
              .update(proxyApiKey)
              .set(patch)
              .where(eq(proxyApiKey.id, input.id))
              .returning({ name: proxyApiKey.name, keyPreview: proxyApiKey.keyPreview });
            const row = rows[0];
            return row ? ({ row } as const) : null;
          }),
        "Failed to update API key"
      );

      if (updated && "insufficientPoints" in updated) return yield* failWith("Not enough points.");
      if (!updated) return yield* failWith("Failed to update API key");
      if (normalizedKey) yield* invalidateApiKeyValidationCache(apiKey.keyHash, apiKey.id);
      return { success: true as const, data: { name: updated.row.name, keyPreview: updated.row.keyPreview } };
    })
  ).pipe(Effect.catch(() => failWith("Failed to update API key")));
});

export const updateApiKeyExpiration = Effect.fn("apiKeys.updateExpiration")(function* (
  userId: string,
  input: UpdateApiKeyExpirationInput
) {
  if (input.expiresAt && input.expiresAt <= new Date()) {
    return failWith("Expiration date must be in the future");
  }
  return yield* withOwnedApiKey(userId, input.id, "Failed to update API key expiration", (apiKey) =>
    Effect.gen(function* () {
      const updated = yield* fromPromise(
        () =>
          db
            .update(proxyApiKey)
            .set({ expiresAt: input.expiresAt })
            .where(eq(proxyApiKey.id, input.id))
            .returning({ expiresAt: proxyApiKey.expiresAt }),
        "Failed to update API key expiration"
      );
      if (!updated[0]) return yield* failWith("Failed to update API key expiration");
      yield* invalidateApiKeyValidationCache(apiKey.keyHash, apiKey.id);
      return { success: true as const, data: { expiresAt: updated[0].expiresAt } };
    })
  ).pipe(Effect.catch(() => failWith("Failed to update API key expiration")));
});

export const updateApiKeyRoaming = Effect.fn("apiKeys.updateRoaming")(function* (
  userId: string,
  input: UpdateApiKeyRoamingInput
) {
  return yield* withOwnedApiKey(userId, input.id, "Failed to update API key roaming", (apiKey) =>
    Effect.gen(function* () {
      const updated = yield* fromPromise(
        () =>
          db
            .update(proxyApiKey)
            .set({ roamingEnabled: input.enabled })
            .where(eq(proxyApiKey.id, input.id))
            .returning({ roamingEnabled: proxyApiKey.roamingEnabled }),
        "Failed to update API key roaming"
      );
      if (!updated[0]) return yield* failWith("Failed to update API key roaming");
      yield* invalidateApiKeyValidationCache(apiKey.keyHash, apiKey.id);
      return { success: true as const, data: { roamingEnabled: updated[0].roamingEnabled } };
    })
  ).pipe(Effect.catch(() => failWith("Failed to update API key roaming")));
});

export const updateApiKeyModelAccess = Effect.fn("apiKeys.updateModelAccess")(function* (
  userId: string,
  input: UpdateApiKeyModelAccessInput
) {
  return yield* withOwnedApiKey(userId, input.id, "Failed to update API key model access", (apiKey) =>
    Effect.gen(function* () {
      const normalizedModels = input.mode === "all" ? [] : modelList(input.models);
      if (input.mode !== "all" && normalizedModels.length === 0) {
        return yield* failWith("Select at least one model");
      }
      const customModelIds = yield* ownedCustomModelIds(userId);
      const invalidModel = normalizedModels.find(
        (model) => !isKnownModelAccessId(model) && !customModelIds.has(model)
      );
      if (invalidModel) return yield* failWith(`Unknown model: ${invalidModel}`);
      const updated = yield* fromPromise(
        () =>
          db
            .update(proxyApiKey)
            .set({ modelAccessMode: input.mode, modelAccessList: normalizedModels })
            .where(eq(proxyApiKey.id, input.id))
            .returning({ modelAccessMode: proxyApiKey.modelAccessMode, modelAccessList: proxyApiKey.modelAccessList }),
        "Failed to update API key model access"
      );
      if (!updated[0]) return yield* failWith("Failed to update API key model access");
      yield* invalidateApiKeyValidationCache(apiKey.keyHash, apiKey.id);
      return {
        success: true as const,
        data: {
          mode: apiKeyAccessModeSchema.safeParse(updated[0].modelAccessMode).success
            ? (updated[0].modelAccessMode as ApiKeyAccessMode)
            : "all",
          models: updated[0].modelAccessList,
        },
      };
    })
  ).pipe(Effect.catch(() => failWith("Failed to update API key model access")));
});

export const updateApiKeyAccountAccess = Effect.fn("apiKeys.updateAccountAccess")(function* (
  userId: string,
  input: UpdateApiKeyAccountAccessInput
) {
  return yield* withOwnedApiKey(userId, input.id, "Failed to update API key account access", (apiKey) =>
    Effect.gen(function* () {
      const normalizedAccounts =
        input.mode === "all"
          ? []
          : Array.from(new Set(input.accounts.map((account) => account.trim()).filter(Boolean))).sort((a, b) =>
              a.localeCompare(b)
            );
      if (input.mode !== "all" && normalizedAccounts.length === 0) {
        return yield* failWith("Select at least one account");
      }
      if (normalizedAccounts.length > 0) {
        const rows = yield* fromPromise(
          () =>
            db
              .select({ id: providerAccount.id })
              .from(providerAccount)
              .where(and(eq(providerAccount.userId, userId), inArray(providerAccount.id, normalizedAccounts))),
          "Failed to update API key account access"
        );
        const validIds = new Set([
          ...rows.map((row) => row.id),
          ...normalizedAccounts.filter(isSyntheticAuthlessAccount),
        ]);
        const invalidId = normalizedAccounts.find((id) => !validIds.has(id));
        if (invalidId) return yield* failWith(`Unknown account: ${invalidId}`);
      }
      const updated = yield* fromPromise(
        () =>
          db
            .update(proxyApiKey)
            .set({ accountAccessMode: input.mode, accountAccessList: normalizedAccounts })
            .where(eq(proxyApiKey.id, input.id))
            .returning({
              accountAccessMode: proxyApiKey.accountAccessMode,
              accountAccessList: proxyApiKey.accountAccessList,
            }),
        "Failed to update API key account access"
      );
      if (!updated[0]) return yield* failWith("Failed to update API key account access");
      yield* invalidateApiKeyValidationCache(apiKey.keyHash, apiKey.id);
      return {
        success: true as const,
        data: {
          mode: apiKeyAccessModeSchema.safeParse(updated[0].accountAccessMode).success
            ? (updated[0].accountAccessMode as ApiKeyAccessMode)
            : "all",
          accounts: updated[0].accountAccessList,
        },
      };
    })
  ).pipe(Effect.catch(() => failWith("Failed to update API key account access")));
});

export const updateApiKeyRateLimits = Effect.fn("apiKeys.updateRateLimits")(function* (
  userId: string,
  input: UpdateApiKeyRateLimitsInput
) {
  return yield* withOwnedApiKey(userId, input.id, "Failed to update API key rate limits", (apiKey) =>
    Effect.gen(function* () {
      const validFamilies = new Set(getAllFamilies());
      const customModelIds = yield* ownedCustomModelIds(userId);
      const seenTargets = new Set<string>();
      for (const rule of input.rules) {
        const key = `${rule.targetType}:${rule.target}`;
        if (seenTargets.has(key)) return yield* failWith(`Duplicate rate limit rule for ${rule.target}`);
        seenTargets.add(key);
        if (
          rule.targetType === "model" &&
          !isModelSupported(resolveModelAlias(rule.target.trim())) &&
          !customModelIds.has(rule.target.trim())
        ) {
          return yield* failWith(`Unknown model: ${rule.target}`);
        }
        if (rule.targetType === "family" && !validFamilies.has(rule.target)) {
          return yield* failWith(`Unknown model family: ${rule.target}`);
        }
        if (rule.perMinute == null && rule.perHour == null && rule.perDay == null) {
          return yield* failWith(`At least one rate limit must be set for ${rule.target}`);
        }
        if (
          (rule.perMinute != null && rule.perMinute <= 0) ||
          (rule.perHour != null && rule.perHour <= 0) ||
          (rule.perDay != null && rule.perDay <= 0)
        ) {
          return yield* failWith("Rate limits must be positive numbers");
        }
      }
      const normalizedRules = input.rules.map((rule) => ({
        ...rule,
        target: rule.targetType === "model" ? resolveModelAlias(rule.target.trim()) : rule.target,
      }));
      yield* fromPromise(
        () => db.delete(proxyApiKeyRateLimit).where(eq(proxyApiKeyRateLimit.apiKeyId, apiKey.id)),
        "Failed to update API key rate limits"
      );
      if (normalizedRules.length > 0) {
        yield* fromPromise(
          () =>
            db.insert(proxyApiKeyRateLimit).values(
              normalizedRules.map((rule) => ({
                apiKeyId: apiKey.id,
                target: rule.target,
                targetType: rule.targetType,
                perMinute: rule.perMinute,
                perHour: rule.perHour,
                perDay: rule.perDay,
              }))
            ),
          "Failed to update API key rate limits"
        );
      }
      yield* invalidateApiKeyValidationCache(apiKey.keyHash, apiKey.id);
      return { success: true as const, data: { rules: normalizedRules } };
    })
  ).pipe(Effect.catch(() => failWith("Failed to update API key rate limits")));
});
