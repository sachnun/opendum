import { Effect } from "effect";
import { compareText } from "@opendum/models/compare";
import { and, asc, desc, eq, inArray, lte } from "drizzle-orm";

import { db, providerAccount, proxyApiKey, keyRateLimit } from "@opendum/database";
import { fromPromise } from "@opendum/api/web/lib/task";
import { internal, notFound, type ServiceFailure } from "@opendum/api/web/errors";
import { decrypt, encrypt, mintKey, keyPreview, hashString } from "@opendum/api/web/lib/encryption";
import { modelAvailability, invalidateValidation } from "@opendum/api/web/lib/proxy/auth";
import { authlessAccounts, isSynthetic } from "@opendum/api/web/lib/proxy/authless-providers";
import { customModels } from "@opendum/api/web/lib/proxy/custom-providers";
import { allFamilies, allModels, familyOf, providersFor, supportsModel, aliasOf } from "@opendum/api/web/lib/proxy/models";
import { roamingByKey as roamingPoints } from "@opendum/api/web/lib/roaming-points";
import { compareEntries } from "@opendum/models/sort";
import { PROVIDER_ACCOUNT_KEYS } from "@opendum/api/web/services/account-providers";
import { UPDATE_COST, debitUserPoints } from "@opendum/api/web/services/points";
import { accessModeSchema, type AccessMode, type CreateInput, type AccountAccessInput, type ExpirationInput, type ModelAccessInput, type NameInput, type RateLimitsInput, type RoamingInput } from "@opendum/providers/contract";

const MIN_LENGTH = 3;
const MAX_LENGTH = 100;
const ALLOWED_PATTERN = /^[A-Za-z0-9_-]+$/;

interface ReadOptions {
  expireActiveKeys?: boolean;
}

function modelList(models: string[]): string[] {
  const aliases = models.map((model) => aliasOf(model.trim()));
  return Array.from(new Set(aliases.filter((model) => model.length > 0))).sort(compareModels);
}

const customModelIds = Effect.fn("apiKeys.customModelIds")(function* (userId: string) {
  const providers = yield* customModels(userId, { includeInactiveAccounts: true });
  const ids = new Set<string>();
  for (const provider of providers) {
    for (const modelId of provider.standaloneModels) ids.add(`${provider.slug}/${modelId}`);
  }
  return ids;
});

function compareModels(left: string, right: string): number {
  return compareEntries({ id: left, family: familyOf(left) }, { id: right, family: familyOf(right) });
}

function buildModels(models: string[], activeProviders: ReadonlySet<string>): string[] {
  const result: string[] = [];
  for (const model of models) {
    result.push(model);
    for (const provider of [...providersFor(model)].sort()) {
      if (activeProviders.has(provider)) result.push(`${provider}/${model}`);
    }
  }
  return result;
}

function knownModel(model: string): boolean {
  if (supportsModel(model)) return true;
  const slash = model.indexOf("/");
  if (slash <= 0) return false;
  const provider = model.slice(0, slash);
  const base = model.slice(slash + 1);
  return supportsModel(base) && providersFor(base).includes(provider);
}

const getOwned = Effect.fn("apiKeys.getOwned")(function* (userId: string, id: string) {
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

type OwnedApiKey = NonNullable<Effect.Success<ReturnType<typeof getOwned>>>;

const withOwned = Effect.fn("apiKeys.withOwned")(function* <T>(
  userId: string,
  id: string,
  failureMessage: string,
  action: (apiKey: OwnedApiKey) => Effect.Effect<T, ServiceFailure>
) {
  const apiKey = yield* getOwned(userId, id);
  if (!apiKey) return yield* notFound("API key not found");
  return yield* action(apiKey);
});

export const getOptions = Effect.fn("apiKeys.getOptions")(function* (userId: string) {
  return yield* buildOptions(userId).pipe(
    Effect.mapError((failure: { cause?: unknown }) => internal("Failed to load API key options", failure.cause ?? failure))
  );
});

const buildOptions = Effect.fnUntraced(function* (userId: string) {
  const apiKeys = yield* fromPromise(
    () => db.select({ id: proxyApiKey.id }).from(proxyApiKey).where(eq(proxyApiKey.userId, userId)),
    "Failed to load API key options"
  );
  const apiKeyIds = apiKeys.map((key) => key.id);
  const rateLimitRows = apiKeyIds.length > 0
    ? yield* fromPromise(
        () =>
          db
            .select({ apiKeyId: keyRateLimit.apiKeyId, target: keyRateLimit.target, targetType: keyRateLimit.targetType, perMinute: keyRateLimit.perMinute, perHour: keyRateLimit.perHour, perDay: keyRateLimit.perDay })
            .from(keyRateLimit)
            .where(inArray(keyRateLimit.apiKeyId, apiKeyIds)),
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
    const customIds = yield* customModelIds(userId);
    const availableModels = [...allModels(), ...customIds].sort(compareModels);
    const availability = yield* modelAvailability(userId);
    const modelAccessModels = buildModels(availableModels, availability.activeProviders);
    const availableFamilies = allFamilies();
    const authlessProviderAccounts = authlessAccounts().map(({ disabledModels: _disabledModels, ...account }) => account);

    const limitsByKey = rateLimitRows.reduce<Record<string, Array<{ target: string; targetType: "model" | "family"; perMinute: number | null; perHour: number | null; perDay: number | null }>>>((acc, row) => {
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
      limitsByKey,
    };
  }
});

export const listApiKeys = Effect.fn("apiKeys.list")(function* (
  userId: string,
  options: ReadOptions = {}
) {
  return yield* listInner(userId, options).pipe(
    Effect.mapError((failure) => internal("Failed to list API keys", failure.cause ?? failure))
  );
});

const listInner = Effect.fnUntraced(function* (
  userId: string,
  options: ReadOptions = {}
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
    const roaming = yield* roamingPoints(userId, apiKeyIds);

    return apiKeys.map(({ encryptedKey, ...apiKey }) =>
      Object.assign(apiKey, {
        keyPreview: encryptedKey ? keyPreview(decrypt(encryptedKey)) : apiKey.keyPreview,
        roamingPointsUsed: roaming.get(apiKey.id) ?? 0,
      })
    );
  }
});

export const createApiKey = Effect.fn("apiKeys.create")(function* (
  userId: string,
  input: CreateInput
) {
  return yield* createInner(userId, input).pipe(
    Effect.catch((failure: { message: string }) =>
      Effect.succeed({ success: false as const, error: failure.message })
    )
  );
});

const createInner = Effect.fnUntraced(function* (
  userId: string,
  input: CreateInput
) {
  const key = mintKey();
  const name = input?.name?.trim() || null;
  const rows = yield* fromPromise(
    () =>
      db
        .insert(proxyApiKey)
        .values({ userId, keyHash: hashString(key), keyPreview: keyPreview(key), encryptedKey: encrypt(key), name, expiresAt: input?.expiresAt ?? null })
        .returning(),
    "Failed to create API key"
  );
  const apiKey = rows[0];
  if (!apiKey) return yield* internal("Failed to create API key");
  return { success: true as const, data: { id: apiKey.id, key, keyPreview: apiKey.keyPreview, name: apiKey.name, expiresAt: apiKey.expiresAt } };
});

const failWith = (message: string) => Effect.succeed({ success: false as const, error: message });

export const toggleApiKey = Effect.fn("apiKeys.toggle")(function* (userId: string, id: string) {
  return yield* withOwned(userId, id, "Failed to toggle API key", (apiKey) =>
    Effect.gen(function* () {
      const isExpired = apiKey.expiresAt != null && apiKey.expiresAt <= new Date();
      const isActive = !(apiKey.isActive && !isExpired);
      const expiresAt = isActive && isExpired ? null : apiKey.expiresAt;
      yield* fromPromise(
        () => db.update(proxyApiKey).set({ isActive, expiresAt }).where(eq(proxyApiKey.id, id)),
        "Failed to toggle API key"
      );
      yield* invalidateValidation(apiKey.keyHash, apiKey.id);
      return { success: true as const, data: { id, isActive, expiresAt } };
    })
  ).pipe(Effect.catch(() => failWith("Failed to toggle API key")));
});

export const deleteApiKey = Effect.fn("apiKeys.delete")(function* (userId: string, id: string) {
  return yield* withOwned(userId, id, "Failed to delete API key", (apiKey) =>
    Effect.gen(function* () {
      yield* fromPromise(
        () => db.delete(proxyApiKey).where(eq(proxyApiKey.id, id)),
        "Failed to delete API key"
      );
      yield* invalidateValidation(apiKey.keyHash, apiKey.id);
      return { success: true as const, data: undefined };
    })
  ).pipe(Effect.catch(() => failWith("Failed to delete API key")));
});

export const revealApiKey = Effect.fn("apiKeys.reveal")(function* (userId: string, id: string) {
  return yield* withOwned<string>(userId, id, "Failed to reveal API key", (apiKey) =>
    apiKey.encryptedKey
      ? Effect.succeed(decrypt(apiKey.encryptedKey))
      : Effect.fail(notFound("This API key was created before the reveal feature. Please generate a new key."))
  ).pipe(
    Effect.map((key) => ({ success: true as const, data: { key } })),
    Effect.catch((failure) => failWith(failure.message))
  );
});

export const updateName = Effect.fn("apiKeys.updateName")(function* (
  userId: string,
  input: NameInput
) {
  return yield* withOwned(userId, input.id, "Failed to update API key", (apiKey) =>
    Effect.gen(function* () {
      const normalizedKey = input.key === undefined ? undefined : input.key.trim();
      const patch: Partial<typeof proxyApiKey.$inferInsert> = { name: input.name.trim() || null };
      let shouldCharge = false;

      if (normalizedKey !== undefined) {
        if (normalizedKey.length < MIN_LENGTH) {
          return yield* failWith(`API key must be at least ${MIN_LENGTH} characters`);
        }
        if (normalizedKey.length > MAX_LENGTH) {
          return yield* failWith(`API key must be at most ${MAX_LENGTH} characters`);
        }
        if (!ALLOWED_PATTERN.test(normalizedKey)) {
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
        patch.keyPreview = keyPreview(normalizedKey);
        patch.encryptedKey = encrypt(normalizedKey);
        shouldCharge = keyHash !== apiKey.keyHash;
      }

      const updated = yield* fromPromise(
        () =>
          db.transaction(async (tx) => {
            if (shouldCharge) {
              const debit = await Effect.runPromise(
                debitUserPoints(tx, userId, UPDATE_COST, "api_key_update")
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
      if (normalizedKey) yield* invalidateValidation(apiKey.keyHash, apiKey.id);
      return { success: true as const, data: { name: updated.row.name, keyPreview: updated.row.keyPreview } };
    })
  ).pipe(Effect.catch(() => failWith("Failed to update API key")));
});

export const updateExpiration = Effect.fn("apiKeys.updateExpiration")(function* (
  userId: string,
  input: ExpirationInput
) {
  if (input.expiresAt && input.expiresAt <= new Date()) {
    return failWith("Expiration date must be in the future");
  }
  return yield* withOwned(userId, input.id, "Failed to update API key expiration", (apiKey) =>
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
      yield* invalidateValidation(apiKey.keyHash, apiKey.id);
      return { success: true as const, data: { expiresAt: updated[0].expiresAt } };
    })
  ).pipe(Effect.catch(() => failWith("Failed to update API key expiration")));
});

export const updateRoaming = Effect.fn("apiKeys.updateRoaming")(function* (
  userId: string,
  input: RoamingInput
) {
  return yield* withOwned(userId, input.id, "Failed to update API key roaming", (apiKey) =>
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
      yield* invalidateValidation(apiKey.keyHash, apiKey.id);
      return { success: true as const, data: { roamingEnabled: updated[0].roamingEnabled } };
    })
  ).pipe(Effect.catch(() => failWith("Failed to update API key roaming")));
});

export const updateModels = Effect.fn("apiKeys.updateModelAccess")(function* (
  userId: string,
  input: ModelAccessInput
) {
  return yield* withOwned(userId, input.id, "Failed to update API key model access", (apiKey) =>
    Effect.gen(function* () {
      const normalizedModels = input.mode === "all" ? [] : modelList(input.models);
      if (input.mode !== "all" && normalizedModels.length === 0) {
        return yield* failWith("Select at least one model");
      }
      const customIds = yield* customModelIds(userId);
      const invalidModel = normalizedModels.find(
        (model) => !knownModel(model) && !customIds.has(model)
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
      yield* invalidateValidation(apiKey.keyHash, apiKey.id);
      return {
        success: true as const,
        data: {
          mode: accessModeSchema.safeParse(updated[0].modelAccessMode).success
            ? (updated[0].modelAccessMode as AccessMode)
            : "all",
          models: updated[0].modelAccessList,
        },
      };
    })
  ).pipe(Effect.catch(() => failWith("Failed to update API key model access")));
});

export const updateAccess = Effect.fn("apiKeys.updateAccountAccess")(function* (
  userId: string,
  input: AccountAccessInput
) {
  return yield* withOwned(userId, input.id, "Failed to update API key account access", (apiKey) =>
    Effect.gen(function* () {
      const normalizedAccounts =
        input.mode === "all"
          ? []
          : Array.from(new Set(input.accounts.map((account) => account.trim()).filter(Boolean))).sort((a, b) =>
              compareText(a, b)
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
          ...normalizedAccounts.filter(isSynthetic),
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
      yield* invalidateValidation(apiKey.keyHash, apiKey.id);
      return {
        success: true as const,
        data: {
          mode: accessModeSchema.safeParse(updated[0].accountAccessMode).success
            ? (updated[0].accountAccessMode as AccessMode)
            : "all",
          accounts: updated[0].accountAccessList,
        },
      };
    })
  ).pipe(Effect.catch(() => failWith("Failed to update API key account access")));
});

export const updateRateLimits = Effect.fn("apiKeys.updateRateLimits")(function* (
  userId: string,
  input: RateLimitsInput
) {
  return yield* withOwned(userId, input.id, "Failed to update API key rate limits", (apiKey) =>
    Effect.gen(function* () {
      const validFamilies = new Set(allFamilies());
      const customIds = yield* customModelIds(userId);
      const seenTargets = new Set<string>();
      for (const rule of input.rules) {
        const key = `${rule.targetType}:${rule.target}`;
        if (seenTargets.has(key)) return yield* failWith(`Duplicate rate limit rule for ${rule.target}`);
        seenTargets.add(key);
        if (
          rule.targetType === "model" &&
          !supportsModel(aliasOf(rule.target.trim())) &&
          !customIds.has(rule.target.trim())
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
        target: rule.targetType === "model" ? aliasOf(rule.target.trim()) : rule.target,
      }));
      yield* fromPromise(
        () => db.delete(keyRateLimit).where(eq(keyRateLimit.apiKeyId, apiKey.id)),
        "Failed to update API key rate limits"
      );
      if (normalizedRules.length > 0) {
        yield* fromPromise(
          () =>
            db.insert(keyRateLimit).values(
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
      yield* invalidateValidation(apiKey.keyHash, apiKey.id);
      return { success: true as const, data: { rules: normalizedRules } };
    })
  ).pipe(Effect.catch(() => failWith("Failed to update API key rate limits")));
});
