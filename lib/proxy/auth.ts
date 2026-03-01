import { Effect } from "effect";
import { DatabaseService, RedisService } from "@/lib/effect/services";
import { RedisError, DatabaseError } from "@/lib/effect/errors";
import { runWithInfra } from "@/lib/effect/runtime";
import { proxyApiKey, disabledModel, usageLog } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { hashString } from "@/lib/encryption";
import { bumpAnalyticsCacheVersionThrottled } from "@/lib/cache/analytics-cache";
import {
  isModelSupported,
  isModelSupportedByProvider,
  getAllModelsWithAliases,
  getProvidersForModel,
  resolveModelAlias,
} from "./models";
import { normalizeProviderAlias } from "./providers/types";

/**
 * Parsed model parameter
 */
export interface ParsedModel {
  provider: string | null;  // null = auto (round-robin across all providers)
  model: string;            // canonical model name
}

export interface ModelValidationResult {
  valid: boolean;
  provider: string | null;
  model: string;
  error?: string;
  param?: string;
  code?: string;
}

export type ApiKeyModelAccessMode = "all" | "whitelist" | "blacklist";

export interface ApiKeyModelAccess {
  mode: ApiKeyModelAccessMode;
  models: string[];
}

function normalizeApiKeyModelAccessMode(mode: string | null | undefined): ApiKeyModelAccessMode {
  if (mode === "whitelist" || mode === "blacklist") {
    return mode;
  }
  return "all";
}

function normalizeApiKeyModelList(models: string[]): string[] {
  const normalized = models
    .map((model) => resolveModelAlias(model.trim()))
    .filter((model) => model.length > 0)
    .filter((model) => isModelSupported(model));

  return Array.from(new Set(normalized)).sort((a, b) => a.localeCompare(b));
}

const API_KEY_VALIDATION_CACHE_PREFIX = "opendum:api-key:validation";
const API_KEY_LAST_USED_THROTTLE_PREFIX = "opendum:api-key:last-used";
const DISABLED_MODELS_CACHE_PREFIX = "opendum:user:disabled-models";

const API_KEY_VALIDATION_POSITIVE_TTL_SECONDS = 45;
const API_KEY_VALIDATION_NEGATIVE_TTL_SECONDS = 10;
const API_KEY_LAST_USED_THROTTLE_SECONDS = 60;
const DISABLED_MODELS_CACHE_TTL_SECONDS = 60;

interface ApiKeyValidationCacheValue {
  valid: boolean;
  userId?: string;
  apiKeyId?: string;
  modelAccessMode?: ApiKeyModelAccessMode;
  modelAccessList?: string[];
  expiresAtMs?: number | null;
  error?: string;
}

interface DisabledModelsCacheValue {
  models: string[];
}

function parseJsonValue<T>(rawValue: string | null): T | null {
  if (!rawValue) {
    return null;
  }

  try {
    return JSON.parse(rawValue) as T;
  } catch {
    return null;
  }
}

function getApiKeyValidationCacheKey(keyHash: string): string {
  return `${API_KEY_VALIDATION_CACHE_PREFIX}:${keyHash}`;
}

function getApiKeyLastUsedThrottleKey(apiKeyId: string): string {
  return `${API_KEY_LAST_USED_THROTTLE_PREFIX}:${apiKeyId}`;
}

function getDisabledModelsCacheKey(userId: string): string {
  return `${DISABLED_MODELS_CACHE_PREFIX}:${userId}`;
}

// ---------------------------------------------------------------------------
// Effect-based internal operations
// ---------------------------------------------------------------------------

const touchApiKeyLastUsedEffect = (
  apiKeyId: string
): Effect.Effect<void, never, RedisService | DatabaseService> =>
  Effect.gen(function* () {
    const redis = yield* RedisService;
    const db = yield* DatabaseService;

    const shouldTouch = yield* Effect.tryPromise({
      try: () =>
        redis.set(
          getApiKeyLastUsedThrottleKey(apiKeyId),
          "1",
          "EX",
          API_KEY_LAST_USED_THROTTLE_SECONDS,
          "NX"
        ),
      catch: () => null,
    }).pipe(Effect.catchAll(() => Effect.succeed(null)));

    if (shouldTouch !== "OK") {
      return;
    }

    yield* Effect.tryPromise({
      try: () =>
        db.update(proxyApiKey).set({ lastUsedAt: new Date() }).where(eq(proxyApiKey.id, apiKeyId)),
      catch: () => null,
    }).pipe(Effect.catchAll(() => Effect.void));
  });

const getCachedApiKeyValidationEffect = (
  keyHash: string
): Effect.Effect<ApiKeyValidationCacheValue | null, RedisError, RedisService> =>
  Effect.gen(function* () {
    const redis = yield* RedisService;

    const rawValue = yield* Effect.tryPromise({
      try: () => redis.get(getApiKeyValidationCacheKey(keyHash)),
      catch: (cause) => new RedisError({ cause }),
    });

    const parsed = parseJsonValue<ApiKeyValidationCacheValue>(rawValue);

    if (!parsed || typeof parsed.valid !== "boolean") {
      return null;
    }

    const modelAccessList = Array.isArray(parsed.modelAccessList)
      ? parsed.modelAccessList.filter((item): item is string => typeof item === "string")
      : [];

    if (parsed.valid) {
      if (!parsed.userId || !parsed.apiKeyId) {
        return null;
      }

      return {
        valid: true,
        userId: parsed.userId,
        apiKeyId: parsed.apiKeyId,
        modelAccessMode: normalizeApiKeyModelAccessMode(parsed.modelAccessMode),
        modelAccessList,
        expiresAtMs:
          typeof parsed.expiresAtMs === "number" || parsed.expiresAtMs === null
            ? parsed.expiresAtMs
            : null,
      };
    }

    return {
      valid: false,
      error: parsed.error ?? "Invalid API key",
    };
  });

const setCachedApiKeyValidationEffect = (
  keyHash: string,
  value: ApiKeyValidationCacheValue,
  ttlSeconds: number
): Effect.Effect<void, RedisError, RedisService> =>
  Effect.gen(function* () {
    const redis = yield* RedisService;

    yield* Effect.tryPromise({
      try: () =>
        redis.set(
          getApiKeyValidationCacheKey(keyHash),
          JSON.stringify(value),
          "EX",
          Math.max(1, Math.floor(ttlSeconds))
        ),
      catch: (cause) => new RedisError({ cause }),
    });
  });

const getDisabledModelsFromDatabaseEffect = (
  userId: string
): Effect.Effect<string[], DatabaseError, DatabaseService> =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    const disabledModels = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ model: disabledModel.model })
          .from(disabledModel)
          .where(eq(disabledModel.userId, userId)),
      catch: (cause) => new DatabaseError({ cause }),
    });

    return Array.from(
      new Set(
        disabledModels
          .map((entry: { model: string }) => resolveModelAlias(entry.model))
          .filter((model: string) => model.length > 0)
      )
    ).sort((a: string, b: string) => a.localeCompare(b));
  });

const getCachedDisabledModelsEffect = (
  userId: string
): Effect.Effect<string[] | null, RedisError, RedisService> =>
  Effect.gen(function* () {
    const redis = yield* RedisService;

    const rawValue = yield* Effect.tryPromise({
      try: () => redis.get(getDisabledModelsCacheKey(userId)),
      catch: (cause) => new RedisError({ cause }),
    });

    const parsed = parseJsonValue<DisabledModelsCacheValue>(rawValue);

    if (!parsed || !Array.isArray(parsed.models)) {
      return null;
    }

    return normalizeApiKeyModelList(
      parsed.models.filter((item): item is string => typeof item === "string")
    );
  });

const setCachedDisabledModelsEffect = (
  userId: string,
  models: string[]
): Effect.Effect<void, RedisError, RedisService> =>
  Effect.gen(function* () {
    const redis = yield* RedisService;

    yield* Effect.tryPromise({
      try: () =>
        redis.set(
          getDisabledModelsCacheKey(userId),
          JSON.stringify({ models: normalizeApiKeyModelList(models) }),
          "EX",
          DISABLED_MODELS_CACHE_TTL_SECONDS
        ),
      catch: (cause) => new RedisError({ cause }),
    });
  });

const isModelDisabledForUserEffect = (
  userId: string,
  model: string
): Effect.Effect<boolean, DatabaseError, RedisService | DatabaseService> =>
  Effect.gen(function* () {
    const cachedModels = yield* getCachedDisabledModelsEffect(userId).pipe(
      Effect.catchTag("RedisError", () => Effect.succeed(null))
    );

    if (cachedModels) {
      return new Set(cachedModels).has(model);
    }

    const disabledModels = yield* getDisabledModelsFromDatabaseEffect(userId);

    yield* setCachedDisabledModelsEffect(userId, disabledModels).pipe(
      Effect.catchTag("RedisError", () => Effect.void)
    );

    return new Set(disabledModels).has(model);
  });

const getDisabledModelSetForUserEffect = (
  userId: string
): Effect.Effect<Set<string>, DatabaseError, RedisService | DatabaseService> =>
  Effect.gen(function* () {
    const cachedModels = yield* getCachedDisabledModelsEffect(userId).pipe(
      Effect.catchTag("RedisError", () => Effect.succeed(null))
    );

    if (cachedModels) {
      return new Set(cachedModels);
    }

    const disabledModels = yield* getDisabledModelsFromDatabaseEffect(userId);

    yield* setCachedDisabledModelsEffect(userId, disabledModels).pipe(
      Effect.catchTag("RedisError", () => Effect.void)
    );

    return new Set(disabledModels);
  });

const invalidateDisabledModelsCacheEffect = (
  userId: string
): Effect.Effect<void, RedisError, RedisService> =>
  Effect.gen(function* () {
    const redis = yield* RedisService;

    yield* Effect.tryPromise({
      try: () => redis.del(getDisabledModelsCacheKey(userId)),
      catch: (cause) => new RedisError({ cause }),
    });
  });

const invalidateApiKeyValidationCacheEffect = (
  keyHash: string,
  apiKeyId?: string
): Effect.Effect<void, RedisError, RedisService> =>
  Effect.gen(function* () {
    const redis = yield* RedisService;

    yield* Effect.tryPromise({
      try: () => redis.del(getApiKeyValidationCacheKey(keyHash)),
      catch: (cause) => new RedisError({ cause }),
    });

    if (apiKeyId) {
      yield* Effect.tryPromise({
        try: () => redis.del(getApiKeyLastUsedThrottleKey(apiKeyId)),
        catch: (cause) => new RedisError({ cause }),
      });
    }
  });

const validateApiKeyEffect = (
  authHeader: string | null
): Effect.Effect<
  {
    valid: boolean;
    userId?: string;
    apiKeyId?: string;
    modelAccessMode?: ApiKeyModelAccessMode;
    modelAccessList?: string[];
    error?: string;
  },
  never,
  RedisService | DatabaseService
> =>
  Effect.gen(function* () {
    if (!authHeader) {
      return { valid: false, error: "Missing Authorization header" };
    }

    const token = authHeader.replace(/^Bearer\s+/i, "").trim();

    if (!token) {
      return { valid: false, error: "Invalid Authorization header format" };
    }

    const keyHash = hashString(token);

    // Try cache first (fail-open on Redis errors)
    const cachedValidation = yield* getCachedApiKeyValidationEffect(keyHash).pipe(
      Effect.catchTag("RedisError", () => Effect.succeed(null))
    );

    if (cachedValidation) {
      if (!cachedValidation.valid) {
        return {
          valid: false,
          error: cachedValidation.error ?? "Invalid API key",
        };
      }

      const expiresAtMs = cachedValidation.expiresAtMs;
      if (typeof expiresAtMs === "number" && expiresAtMs <= Date.now()) {
        yield* invalidateApiKeyValidationCacheEffect(keyHash, cachedValidation.apiKeyId).pipe(
          Effect.catchTag("RedisError", () => Effect.void)
        );
      } else {
        // Fire-and-forget last-used touch
        yield* Effect.fork(touchApiKeyLastUsedEffect(cachedValidation.apiKeyId!));
        return {
          valid: true,
          userId: cachedValidation.userId,
          apiKeyId: cachedValidation.apiKeyId,
          modelAccessMode: normalizeApiKeyModelAccessMode(
            cachedValidation.modelAccessMode
          ),
          modelAccessList: normalizeApiKeyModelList(
            cachedValidation.modelAccessList ?? []
          ),
        };
      }
    }

    // Query database
    const db = yield* DatabaseService;

    const apiKeyRows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            id: proxyApiKey.id,
            userId: proxyApiKey.userId,
            isActive: proxyApiKey.isActive,
            expiresAt: proxyApiKey.expiresAt,
            modelAccessMode: proxyApiKey.modelAccessMode,
            modelAccessList: proxyApiKey.modelAccessList,
          })
          .from(proxyApiKey)
          .where(eq(proxyApiKey.keyHash, keyHash))
          .limit(1),
      catch: () => null,
    }).pipe(Effect.catchAll(() => Effect.succeed([] as typeof proxyApiKey.$inferSelect[])));

    const apiKey = (apiKeyRows as Array<{
      id: string;
      userId: string;
      isActive: boolean;
      expiresAt: Date | null;
      modelAccessMode: string;
      modelAccessList: string[];
    }>)[0];

    if (!apiKey) {
      yield* setCachedApiKeyValidationEffect(
        keyHash,
        { valid: false, error: "Invalid API key" },
        API_KEY_VALIDATION_NEGATIVE_TTL_SECONDS
      ).pipe(Effect.catchTag("RedisError", () => Effect.void));
      return { valid: false, error: "Invalid API key" };
    }

    if (!apiKey.isActive) {
      yield* setCachedApiKeyValidationEffect(
        keyHash,
        { valid: false, error: "API key has been revoked" },
        API_KEY_VALIDATION_NEGATIVE_TTL_SECONDS
      ).pipe(Effect.catchTag("RedisError", () => Effect.void));
      return { valid: false, error: "API key has been revoked" };
    }

    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      yield* setCachedApiKeyValidationEffect(
        keyHash,
        { valid: false, error: "API key has expired" },
        API_KEY_VALIDATION_NEGATIVE_TTL_SECONDS
      ).pipe(Effect.catchTag("RedisError", () => Effect.void));
      return { valid: false, error: "API key has expired" };
    }

    const modelAccessMode = normalizeApiKeyModelAccessMode(apiKey.modelAccessMode);
    const modelAccessList = normalizeApiKeyModelList(apiKey.modelAccessList);
    const expiresAtMs = apiKey.expiresAt ? apiKey.expiresAt.getTime() : null;

    let cacheTtlSeconds = API_KEY_VALIDATION_POSITIVE_TTL_SECONDS;
    if (typeof expiresAtMs === "number") {
      const secondsUntilExpiry = Math.floor((expiresAtMs - Date.now()) / 1000);
      cacheTtlSeconds = Math.max(1, Math.min(cacheTtlSeconds, secondsUntilExpiry));
    }

    yield* setCachedApiKeyValidationEffect(
      keyHash,
      {
        valid: true,
        userId: apiKey.userId,
        apiKeyId: apiKey.id,
        modelAccessMode,
        modelAccessList,
        expiresAtMs,
      },
      cacheTtlSeconds
    ).pipe(Effect.catchTag("RedisError", () => Effect.void));

    // Fire-and-forget last-used touch
    yield* Effect.fork(touchApiKeyLastUsedEffect(apiKey.id));

    return {
      valid: true,
      userId: apiKey.userId,
      apiKeyId: apiKey.id,
      modelAccessMode,
      modelAccessList,
    };
  });

const logUsageEffect = (
  params: {
    userId: string;
    providerAccountId?: string;
    proxyApiKeyId?: string;
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    statusCode?: number;
    duration?: number;
    provider?: string;
  }
): Effect.Effect<void, never, DatabaseService> =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    yield* Effect.tryPromise({
      try: () =>
        db.insert(usageLog).values({
          userId: params.userId,
          providerAccountId: params.providerAccountId,
          proxyApiKeyId: params.proxyApiKeyId,
          model: params.model,
          inputTokens: params.inputTokens ?? 0,
          outputTokens: params.outputTokens ?? 0,
          statusCode: params.statusCode,
          duration: params.duration,
        }),
      catch: (error) => error,
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          void bumpAnalyticsCacheVersionThrottled(params.userId);
        })
      ),
      Effect.catchAll((error) =>
        Effect.sync(() => {
          console.error("Failed to log usage:", error);
        })
      )
    );
  });

// ---------------------------------------------------------------------------
// Public API — signatures unchanged
// ---------------------------------------------------------------------------

/**
 * Parse model parameter that can be:
 * - "model" (auto - use any provider)
 * - "provider/model" (specific provider)
 */
export function parseModelParam(modelParam: string): ParsedModel {
  const slashIndex = modelParam.indexOf("/");
  
  if (slashIndex === -1) {
    return { provider: null, model: modelParam };
  }
  
  const provider = normalizeProviderAlias(modelParam.substring(0, slashIndex));
  const model = modelParam.substring(slashIndex + 1);
  
  return { provider, model };
}

/**
 * Validate model parameter against available models
 * Supports both "model" and "provider/model" formats
 */
export function validateModel(modelParam: string): ModelValidationResult {
  const { provider, model: rawModel } = parseModelParam(modelParam);
  const model = resolveModelAlias(rawModel);
  
  if (!isModelSupported(model)) {
    const allModels = getAllModelsWithAliases();
    return {
      valid: false,
      provider,
      model: rawModel,
      error: `Invalid model: ${rawModel}. Available models: ${allModels.sort().join(", ")}`,
      param: "model",
      code: "invalid_model",
    };
  }
  
  if (provider !== null) {
    if (!isModelSupportedByProvider(model, provider)) {
      const supportedProviders = getProvidersForModel(model);
      return {
        valid: false,
        provider,
        model,
        error: `Model "${model}" is not supported by provider "${provider}". Supported providers: ${supportedProviders.join(", ")}`,
        param: "model",
        code: "invalid_provider_model",
      };
    }
  }
  
  return { valid: true, provider, model };
}

/**
 * Validate model against registry and user-specific enabled/disabled state.
 */
export async function validateModelForUser(
  userId: string,
  modelParam: string,
  apiKeyModelAccess?: ApiKeyModelAccess
): Promise<ModelValidationResult> {
  const baseValidation = validateModel(modelParam);

  if (!baseValidation.valid) {
    return baseValidation;
  }

  return runWithInfra(
    Effect.gen(function* () {
      const modelIsDisabled = yield* isModelDisabledForUserEffect(
        userId,
        baseValidation.model
      ).pipe(Effect.catchTag("DatabaseError", () => Effect.succeed(false)));

      if (modelIsDisabled) {
        return {
          valid: false,
          provider: baseValidation.provider,
          model: baseValidation.model,
          error: `Model "${baseValidation.model}" is disabled. Enable it from Dashboard > Models first.`,
          param: "model",
          code: "model_disabled",
        } satisfies ModelValidationResult;
      }

      if (apiKeyModelAccess) {
        const mode = normalizeApiKeyModelAccessMode(apiKeyModelAccess.mode);
        const modelSet = new Set(normalizeApiKeyModelList(apiKeyModelAccess.models));

        if (mode === "whitelist" && !modelSet.has(baseValidation.model)) {
          const allowedModels = Array.from(modelSet.values()).slice(0, 8);
          const allowedModelsMessage =
            allowedModels.length > 0
              ? `. Allowed models: ${allowedModels.join(", ")}${
                  modelSet.size > allowedModels.length ? ` (+${modelSet.size - allowedModels.length} more)` : ""
                }`
              : "";

          return {
            valid: false,
            provider: baseValidation.provider,
            model: baseValidation.model,
            error: `Model "${baseValidation.model}" is not allowed for this API key${allowedModelsMessage}.`,
            param: "model",
            code: "model_not_whitelisted",
          } satisfies ModelValidationResult;
        }

        if (mode === "blacklist" && modelSet.has(baseValidation.model)) {
          return {
            valid: false,
            provider: baseValidation.provider,
            model: baseValidation.model,
            error: `Model "${baseValidation.model}" is blocked for this API key.`,
            param: "model",
            code: "model_blacklisted",
          } satisfies ModelValidationResult;
        }
      }

      return baseValidation;
    })
  );
}

export async function getDisabledModelSetForUser(userId: string): Promise<Set<string>> {
  return runWithInfra(
    getDisabledModelSetForUserEffect(userId).pipe(
      Effect.catchTag("DatabaseError", () => Effect.succeed(new Set<string>()))
    )
  );
}

export async function invalidateDisabledModelsCache(userId: string): Promise<void> {
  return runWithInfra(
    invalidateDisabledModelsCacheEffect(userId).pipe(
      Effect.catchTag("RedisError", () => Effect.void)
    )
  );
}

export async function invalidateApiKeyValidationCache(
  keyHash: string,
  apiKeyId?: string
): Promise<void> {
  return runWithInfra(
    invalidateApiKeyValidationCacheEffect(keyHash, apiKeyId).pipe(
      Effect.catchTag("RedisError", () => Effect.void)
    )
  );
}

/**
 * Validate proxy API key and return user info
 */
export async function validateApiKey(authHeader: string | null): Promise<{
  valid: boolean;
  userId?: string;
  apiKeyId?: string;
  modelAccessMode?: ApiKeyModelAccessMode;
  modelAccessList?: string[];
  error?: string;
}> {
  return runWithInfra(validateApiKeyEffect(authHeader));
}

/**
 * Log usage to database
 */
export async function logUsage(params: {
  userId: string;
  providerAccountId?: string;
  proxyApiKeyId?: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  statusCode?: number;
  duration?: number;
  provider?: string;
}): Promise<void> {
  return runWithInfra(logUsageEffect(params));
}
