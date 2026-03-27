import { db } from "../db/index.js";
import { proxyApiKey, proxyApiKeyRateLimit, disabledModel, usageLog, providerAccount, providerAccountDisabledModel } from "../db/schema.js";
import { eq, and, inArray } from "drizzle-orm";
import { hashString } from "../encryption.js";
import { bumpAnalyticsCacheVersionThrottled } from "../cache/analytics-cache.js";
import { getRedisClient } from "../redis.js";
import {
  isModelSupported,
  isModelSupportedByProvider,
  getAllModelsWithAliases,
  getProvidersForModel,
  resolveModelAlias,
} from "./models.js";
import { normalizeProviderAlias } from "./providers/types.js";

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

export type ApiKeyAccountAccessMode = "all" | "whitelist" | "blacklist";

export interface ApiKeyAccountAccess {
  mode: ApiKeyAccountAccessMode;
  accounts: string[];
}

function normalizeApiKeyModelAccessMode(mode: string | null | undefined): ApiKeyModelAccessMode {
  if (mode === "whitelist" || mode === "blacklist") {
    return mode;
  }
  return "all";
}

function normalizeApiKeyAccountAccessMode(mode: string | null | undefined): ApiKeyAccountAccessMode {
  if (mode === "whitelist" || mode === "blacklist") {
    return mode;
  }
  return "all";
}

function normalizeApiKeyAccountList(accounts: string[]): string[] {
  const normalized = accounts
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  return Array.from(new Set(normalized)).sort((a, b) => a.localeCompare(b));
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

export interface RateLimitRule {
  target: string;
  targetType: "model" | "family";
  perMinute: number | null;
  perHour: number | null;
  perDay: number | null;
}

interface ApiKeyValidationCacheValue {
  valid: boolean;
  userId?: string;
  apiKeyId?: string;
  modelAccessMode?: ApiKeyModelAccessMode;
  modelAccessList?: string[];
  accountAccessMode?: ApiKeyAccountAccessMode;
  accountAccessList?: string[];
  expiresAtMs?: number | null;
  rateLimitRules?: RateLimitRule[];
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

async function touchApiKeyLastUsed(apiKeyId: string): Promise<void> {
  const redis = await getRedisClient();

  try {
    const shouldTouch = await redis.set(
      getApiKeyLastUsedThrottleKey(apiKeyId),
      "1",
      "EX",
      API_KEY_LAST_USED_THROTTLE_SECONDS,
      "NX"
    );

    if (shouldTouch !== "OK") {
      return;
    }
  } catch {
    // Fall through to direct DB update
  }

  try {
    await db.update(proxyApiKey).set({ lastUsedAt: new Date() }).where(eq(proxyApiKey.id, apiKeyId));
  } catch {
    // Best effort update only
  }
}

async function getCachedApiKeyValidation(
  keyHash: string
): Promise<ApiKeyValidationCacheValue | null> {
  const redis = await getRedisClient();

  try {
    const rawValue = await redis.get(getApiKeyValidationCacheKey(keyHash));
    const parsed = parseJsonValue<ApiKeyValidationCacheValue>(rawValue);

    if (!parsed || typeof parsed.valid !== "boolean") {
      return null;
    }

    const modelAccessList = Array.isArray(parsed.modelAccessList)
      ? parsed.modelAccessList.filter((item): item is string => typeof item === "string")
      : [];

    const accountAccessList = Array.isArray(parsed.accountAccessList)
      ? parsed.accountAccessList.filter((item): item is string => typeof item === "string")
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
        accountAccessMode: normalizeApiKeyAccountAccessMode(parsed.accountAccessMode),
        accountAccessList,
        expiresAtMs:
          typeof parsed.expiresAtMs === "number" || parsed.expiresAtMs === null
            ? parsed.expiresAtMs
            : null,
        rateLimitRules: Array.isArray(parsed.rateLimitRules)
          ? parsed.rateLimitRules
          : [],
      };
    }

    return {
      valid: false,
      error: parsed.error ?? "Invalid API key",
    };
  } catch {
    return null;
  }
}

async function setCachedApiKeyValidation(
  keyHash: string,
  value: ApiKeyValidationCacheValue,
  ttlSeconds: number
): Promise<void> {
  const redis = await getRedisClient();

  try {
    await redis.set(getApiKeyValidationCacheKey(keyHash), JSON.stringify(value), "EX", Math.max(1, Math.floor(ttlSeconds)));
  } catch {
    // Ignore cache write errors
  }
}

async function getDisabledModelsFromDatabase(userId: string): Promise<string[]> {
  const disabledModels = await db
    .select({ model: disabledModel.model })
    .from(disabledModel)
    .where(eq(disabledModel.userId, userId));

  return Array.from(
    new Set(
      disabledModels
        .map((entry: { model: string }) => resolveModelAlias(entry.model))
        .filter((model: string) => model.length > 0)
    )
  ).sort((a: string, b: string) => a.localeCompare(b));
}

async function getCachedDisabledModels(userId: string): Promise<string[] | null> {
  const redis = await getRedisClient();

  try {
    const rawValue = await redis.get(getDisabledModelsCacheKey(userId));
    const parsed = parseJsonValue<DisabledModelsCacheValue>(rawValue);

    if (!parsed || !Array.isArray(parsed.models)) {
      return null;
    }

    return normalizeApiKeyModelList(
      parsed.models.filter((item): item is string => typeof item === "string")
    );
  } catch {
    return null;
  }
}

async function setCachedDisabledModels(userId: string, models: string[]): Promise<void> {
  const redis = await getRedisClient();

  try {
    await redis.set(
      getDisabledModelsCacheKey(userId),
      JSON.stringify({ models: normalizeApiKeyModelList(models) }),
      "EX",
      DISABLED_MODELS_CACHE_TTL_SECONDS
    );
  } catch {
    // Ignore cache write errors
  }
}

// In-memory cache for disabled model Sets (avoids recreating Set from array each call)
const disabledModelSetMemCache = new Map<string, { set: Set<string>; expiresAt: number }>();
const DISABLED_MODELS_MEM_CACHE_TTL_MS = 10_000; // 10 seconds

function getCachedDisabledModelSet(userId: string): Set<string> | null {
  const entry = disabledModelSetMemCache.get(userId);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    disabledModelSetMemCache.delete(userId);
    return null;
  }
  return entry.set;
}

function setCachedDisabledModelSet(userId: string, models: string[]): Set<string> {
  const set = new Set(models);
  disabledModelSetMemCache.set(userId, {
    set,
    expiresAt: Date.now() + DISABLED_MODELS_MEM_CACHE_TTL_MS,
  });
  return set;
}

async function isModelDisabledForUser(userId: string, model: string): Promise<boolean> {
  const memCached = getCachedDisabledModelSet(userId);
  if (memCached) return memCached.has(model);

  const cachedModels = await getCachedDisabledModels(userId);
  if (cachedModels) {
    return setCachedDisabledModelSet(userId, cachedModels).has(model);
  }

  const disabledModels = await getDisabledModelsFromDatabase(userId);
  await setCachedDisabledModels(userId, disabledModels);
  return setCachedDisabledModelSet(userId, disabledModels).has(model);
}

export async function getDisabledModelSetForUser(userId: string): Promise<Set<string>> {
  const memCached = getCachedDisabledModelSet(userId);
  if (memCached) return memCached;

  const cachedModels = await getCachedDisabledModels(userId);
  if (cachedModels) {
    return setCachedDisabledModelSet(userId, cachedModels);
  }

  const disabledModels = await getDisabledModelsFromDatabase(userId);
  await setCachedDisabledModels(userId, disabledModels);
  return setCachedDisabledModelSet(userId, disabledModels);
}

export async function invalidateDisabledModelsCache(userId: string): Promise<void> {
  disabledModelSetMemCache.delete(userId);
  const redis = await getRedisClient();

  try {
    await redis.del(getDisabledModelsCacheKey(userId));
  } catch {
    // Ignore cache invalidation failures
  }
}

export async function invalidateApiKeyValidationCache(
  keyHash: string,
  apiKeyId?: string
): Promise<void> {
  const redis = await getRedisClient();

  try {
    await redis.del(getApiKeyValidationCacheKey(keyHash));
    if (apiKeyId) {
      await redis.del(getApiKeyLastUsedThrottleKey(apiKeyId));
    }
  } catch {
    // Ignore cache invalidation failures
  }
}

/**
 * Parse model parameter that can be:
 * - "model" (auto - use any provider)
 * - "provider/model" (specific provider)
 * 
 * @example parseModelParam("qwen3-coder-plus") => { provider: null, model: "qwen3-coder-plus" }
 * @example parseModelParam("antigravity/qwen3-coder-plus") => { provider: "antigravity", model: "qwen3-coder-plus" }
 */
export function parseModelParam(modelParam: string): ParsedModel {
  const slashIndex = modelParam.indexOf("/");
  
  if (slashIndex === -1) {
    // No slash - auto mode
    return { provider: null, model: modelParam };
  }
  
  // Has slash - provider/model format
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
  
  // Check if model exists
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
  
  // If provider specified, check if it supports this model
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

  const modelIsDisabled = await isModelDisabledForUser(userId, baseValidation.model);

  if (modelIsDisabled) {
    return {
      valid: false,
      provider: baseValidation.provider,
      model: baseValidation.model,
      error: `Model "${baseValidation.model}" is disabled. Enable it from Dashboard > Models first.`,
      param: "model",
      code: "model_disabled",
    };
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
      };
    }

    if (mode === "blacklist" && modelSet.has(baseValidation.model)) {
      return {
        valid: false,
        provider: baseValidation.provider,
        model: baseValidation.model,
        error: `Model "${baseValidation.model}" is blocked for this API key.`,
        param: "model",
        code: "model_blacklisted",
      };
    }
  }

  return baseValidation;
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
  accountAccessMode?: ApiKeyAccountAccessMode;
  accountAccessList?: string[];
  rateLimitRules?: RateLimitRule[];
  error?: string;
}> {
  if (!authHeader) {
    return { valid: false, error: "Missing Authorization header" };
  }

  // Extract token from "Bearer <token>"
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    return { valid: false, error: "Invalid Authorization header format" };
  }

  // Hash the token for lookup
  const keyHash = hashString(token);

  const cachedValidation = await getCachedApiKeyValidation(keyHash);
  if (cachedValidation) {
    if (!cachedValidation.valid) {
      return {
        valid: false,
        error: cachedValidation.error ?? "Invalid API key",
      };
    }

    const expiresAtMs = cachedValidation.expiresAtMs;
    if (typeof expiresAtMs === "number" && expiresAtMs <= Date.now()) {
      await invalidateApiKeyValidationCache(keyHash, cachedValidation.apiKeyId);
    } else {
      void touchApiKeyLastUsed(cachedValidation.apiKeyId!);
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
        accountAccessMode: normalizeApiKeyAccountAccessMode(
          cachedValidation.accountAccessMode
        ),
        accountAccessList: normalizeApiKeyAccountList(
          cachedValidation.accountAccessList ?? []
        ),
        rateLimitRules: cachedValidation.rateLimitRules ?? [],
      };
    }
  }

  // Find the API key
  const [apiKey] = await db
    .select({
      id: proxyApiKey.id,
      userId: proxyApiKey.userId,
      isActive: proxyApiKey.isActive,
      expiresAt: proxyApiKey.expiresAt,
      modelAccessMode: proxyApiKey.modelAccessMode,
      modelAccessList: proxyApiKey.modelAccessList,
      accountAccessMode: proxyApiKey.accountAccessMode,
      accountAccessList: proxyApiKey.accountAccessList,
    })
    .from(proxyApiKey)
    .where(eq(proxyApiKey.keyHash, keyHash))
    .limit(1);

  if (!apiKey) {
    await setCachedApiKeyValidation(
      keyHash,
      { valid: false, error: "Invalid API key" },
      API_KEY_VALIDATION_NEGATIVE_TTL_SECONDS
    );
    return { valid: false, error: "Invalid API key" };
  }

  if (!apiKey.isActive) {
    await setCachedApiKeyValidation(
      keyHash,
      { valid: false, error: "API key has been revoked" },
      API_KEY_VALIDATION_NEGATIVE_TTL_SECONDS
    );
    return { valid: false, error: "API key has been revoked" };
  }

  // Check if key has expired
  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
    // Auto-disable expired key (fire-and-forget)
    void db.update(proxyApiKey).set({ isActive: false }).where(eq(proxyApiKey.id, apiKey.id)).catch(() => {});
    await setCachedApiKeyValidation(
      keyHash,
      { valid: false, error: "API key has expired" },
      API_KEY_VALIDATION_NEGATIVE_TTL_SECONDS
    );
    return { valid: false, error: "API key has expired" };
  }

  // Fetch rate limit rules for this API key
  const rateLimitRows = await db
    .select({
      target: proxyApiKeyRateLimit.target,
      targetType: proxyApiKeyRateLimit.targetType,
      perMinute: proxyApiKeyRateLimit.perMinute,
      perHour: proxyApiKeyRateLimit.perHour,
      perDay: proxyApiKeyRateLimit.perDay,
    })
    .from(proxyApiKeyRateLimit)
    .where(eq(proxyApiKeyRateLimit.apiKeyId, apiKey.id));

  const rateLimitRules: RateLimitRule[] = rateLimitRows.map((row) => ({
    target: row.target,
    targetType: row.targetType as "model" | "family",
    perMinute: row.perMinute,
    perHour: row.perHour,
    perDay: row.perDay,
  }));

  const modelAccessMode = normalizeApiKeyModelAccessMode(apiKey.modelAccessMode);
  const modelAccessList = normalizeApiKeyModelList(apiKey.modelAccessList);
  const accountAccessMode = normalizeApiKeyAccountAccessMode(apiKey.accountAccessMode);
  const accountAccessList = normalizeApiKeyAccountList(apiKey.accountAccessList);
  const expiresAtMs = apiKey.expiresAt ? apiKey.expiresAt.getTime() : null;

  let cacheTtlSeconds = API_KEY_VALIDATION_POSITIVE_TTL_SECONDS;
  if (typeof expiresAtMs === "number") {
    const secondsUntilExpiry = Math.floor((expiresAtMs - Date.now()) / 1000);
    cacheTtlSeconds = Math.max(1, Math.min(cacheTtlSeconds, secondsUntilExpiry));
  }

  await setCachedApiKeyValidation(
    keyHash,
    {
      valid: true,
      userId: apiKey.userId,
      apiKeyId: apiKey.id,
      modelAccessMode,
      modelAccessList,
      accountAccessMode,
      accountAccessList,
      expiresAtMs,
      rateLimitRules,
    },
    cacheTtlSeconds
  );

  void touchApiKeyLastUsed(apiKey.id);

  return {
    valid: true,
    userId: apiKey.userId,
    apiKeyId: apiKey.id,
    modelAccessMode,
    modelAccessList,
    accountAccessMode,
    accountAccessList,
    rateLimitRules,
  };
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
  try {
    await db.insert(usageLog).values({
      userId: params.userId,
      providerAccountId: params.providerAccountId,
      proxyApiKeyId: params.proxyApiKeyId,
      model: params.model,
      inputTokens: params.inputTokens ?? 0,
      outputTokens: params.outputTokens ?? 0,
      statusCode: params.statusCode,
      duration: params.duration,
    });

    void bumpAnalyticsCacheVersionThrottled(params.userId);
  } catch (error) {
    console.error("Failed to log usage:", error);
  }
}

/**
 * Account-level model availability data for a user.
 */
export interface AccountModelAvailability {
  /** Set of provider names where the user has at least one active account. */
  activeProviders: Set<string>;
  /**
   * For each provider, the number of active accounts.
   * Used together with `disabledCountByProviderModel` to determine whether
   * ALL accounts for a provider have disabled a particular model.
   */
  accountCountByProvider: Map<string, number>;
  /**
   * Map of `"provider:model"` → number of active accounts that have disabled that model.
   */
  disabledCountByProviderModel: Map<string, number>;
}

/**
 * Check whether a model has at least one usable active account across its supporting providers.
 *
 * A model is "usable" if there exists at least one provider P such that:
 *   - P supports the model, AND
 *   - The user has at least one active account for P that has NOT disabled
 *     the model at the per-account level.
 */
export function isModelUsableByAccounts(
  model: string,
  availability: AccountModelAvailability
): boolean {
  const canonical = resolveModelAlias(model);
  const providers = getProvidersForModel(canonical);

  for (const provider of providers) {
    const totalAccounts = availability.accountCountByProvider.get(provider) ?? 0;
    if (totalAccounts === 0) continue;

    const key = `${provider}:${canonical}`;
    const disabledCount = availability.disabledCountByProviderModel.get(key) ?? 0;

    // At least one account for this provider has NOT disabled the model
    if (disabledCount < totalAccounts) {
      return true;
    }
  }

  return false;
}

/**
 * Fetch account-level model availability data for a user.
 *
 * Queries active provider accounts and their per-account disabled models,
 * then builds a structure that allows efficient per-model availability checks
 * via `isModelUsableByAccounts()`.
 */
export async function getAccountModelAvailability(
  userId: string
): Promise<AccountModelAvailability> {
  // 1. Get all active accounts (id + provider)
  const activeAccounts = await db
    .select({
      id: providerAccount.id,
      provider: providerAccount.provider,
    })
    .from(providerAccount)
    .where(
      and(
        eq(providerAccount.userId, userId),
        eq(providerAccount.isActive, true)
      )
    );

  const activeProviders = new Set<string>();
  const accountCountByProvider = new Map<string, number>();
  const accountIdToProvider = new Map<string, string>();

  for (const acc of activeAccounts) {
    activeProviders.add(acc.provider);
    accountCountByProvider.set(
      acc.provider,
      (accountCountByProvider.get(acc.provider) ?? 0) + 1
    );
    accountIdToProvider.set(acc.id, acc.provider);
  }

  // 2. Get per-account disabled models for all active accounts
  const disabledCountByProviderModel = new Map<string, number>();

  if (activeAccounts.length > 0) {
    const accountIds = activeAccounts.map((a) => a.id);
    const disabledEntries = await db
      .select({
        providerAccountId: providerAccountDisabledModel.providerAccountId,
        model: providerAccountDisabledModel.model,
      })
      .from(providerAccountDisabledModel)
      .where(
        inArray(providerAccountDisabledModel.providerAccountId, accountIds)
      );

    for (const entry of disabledEntries) {
      const provider = accountIdToProvider.get(entry.providerAccountId);
      if (!provider) continue;

      const canonical = resolveModelAlias(entry.model);
      const key = `${provider}:${canonical}`;
      disabledCountByProviderModel.set(
        key,
        (disabledCountByProviderModel.get(key) ?? 0) + 1
      );
    }
  }

  return {
    activeProviders,
    accountCountByProvider,
    disabledCountByProviderModel,
  };
}
