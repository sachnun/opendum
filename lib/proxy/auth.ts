import { prisma } from "@/lib/db";
import { hashString } from "@/lib/encryption";
import { bumpAnalyticsCacheVersionThrottled } from "@/lib/cache/analytics-cache";
import { getRedisClient } from "@/lib/redis";
import {
  getModelLookupKeys,
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

async function touchApiKeyLastUsed(apiKeyId: string): Promise<void> {
  const redis = await getRedisClient();

  if (redis) {
    try {
      const shouldTouch = await redis.set(
        getApiKeyLastUsedThrottleKey(apiKeyId),
        "1",
        {
          NX: true,
          EX: API_KEY_LAST_USED_THROTTLE_SECONDS,
        }
      );

      if (shouldTouch !== "OK") {
        return;
      }
    } catch {
      // Fall through to direct DB update
    }
  }

  try {
    await prisma.proxyApiKey.update({
      where: { id: apiKeyId },
      data: { lastUsedAt: new Date() },
    });
  } catch {
    // Best effort update only
  }
}

async function getCachedApiKeyValidation(
  keyHash: string
): Promise<ApiKeyValidationCacheValue | null> {
  const redis = await getRedisClient();
  if (!redis) {
    return null;
  }

  try {
    const rawValue = await redis.get(getApiKeyValidationCacheKey(keyHash));
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
  if (!redis) {
    return;
  }

  try {
    await redis.set(getApiKeyValidationCacheKey(keyHash), JSON.stringify(value), {
      EX: Math.max(1, Math.floor(ttlSeconds)),
    });
  } catch {
    // Ignore cache write errors
  }
}

async function getDisabledModelsFromDatabase(userId: string): Promise<string[]> {
  const disabledModels = await prisma.disabledModel.findMany({
    where: { userId },
    select: { model: true },
  });

  return Array.from(
    new Set(
      disabledModels
        .map((entry) => resolveModelAlias(entry.model))
        .filter((model) => model.length > 0)
    )
  ).sort((a, b) => a.localeCompare(b));
}

async function getCachedDisabledModels(userId: string): Promise<string[] | null> {
  const redis = await getRedisClient();
  if (!redis) {
    return null;
  }

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
  if (!redis) {
    return;
  }

  try {
    await redis.set(
      getDisabledModelsCacheKey(userId),
      JSON.stringify({ models: normalizeApiKeyModelList(models) }),
      {
        EX: DISABLED_MODELS_CACHE_TTL_SECONDS,
      }
    );
  } catch {
    // Ignore cache write errors
  }
}

async function isModelDisabledForUser(userId: string, model: string): Promise<boolean> {
  const redis = await getRedisClient();
  if (!redis) {
    const disabledModel = await prisma.disabledModel.findFirst({
      where: {
        userId,
        model: { in: getModelLookupKeys(model) },
      },
      select: { id: true },
    });

    return Boolean(disabledModel);
  }

  const cachedModels = await getCachedDisabledModels(userId);
  if (cachedModels) {
    return new Set(cachedModels).has(model);
  }

  const disabledModels = await getDisabledModelsFromDatabase(userId);
  await setCachedDisabledModels(userId, disabledModels);
  return new Set(disabledModels).has(model);
}

export async function getDisabledModelSetForUser(userId: string): Promise<Set<string>> {
  const cachedModels = await getCachedDisabledModels(userId);
  if (cachedModels) {
    return new Set(cachedModels);
  }

  const disabledModels = await getDisabledModelsFromDatabase(userId);
  await setCachedDisabledModels(userId, disabledModels);
  return new Set(disabledModels);
}

export async function invalidateDisabledModelsCache(userId: string): Promise<void> {
  const redis = await getRedisClient();
  if (!redis) {
    return;
  }

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
  if (!redis) {
    return;
  }

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
 * @example parseModelParam("iflow/qwen3-coder-plus") => { provider: "iflow", model: "qwen3-coder-plus" }
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
      };
    }
  }

  // Find the API key
  const apiKey = await prisma.proxyApiKey.findUnique({
    where: { keyHash },
    select: {
      id: true,
      userId: true,
      isActive: true,
      expiresAt: true,
      modelAccessMode: true,
      modelAccessList: true,
    },
  });

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
    await setCachedApiKeyValidation(
      keyHash,
      { valid: false, error: "API key has expired" },
      API_KEY_VALIDATION_NEGATIVE_TTL_SECONDS
    );
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

  await setCachedApiKeyValidation(
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
  );

  void touchApiKeyLastUsed(apiKey.id);

  return {
    valid: true,
    userId: apiKey.userId,
    apiKeyId: apiKey.id,
    modelAccessMode,
    modelAccessList,
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
    await prisma.usageLog.create({
      data: {
        userId: params.userId,
        providerAccountId: params.providerAccountId,
        proxyApiKeyId: params.proxyApiKeyId,
        model: params.model,
        inputTokens: params.inputTokens ?? 0,
        outputTokens: params.outputTokens ?? 0,
        statusCode: params.statusCode,
        duration: params.duration,
      },
    });

    void bumpAnalyticsCacheVersionThrottled(params.userId);
  } catch (error) {
    console.error("Failed to log usage:", error);
  }
}
