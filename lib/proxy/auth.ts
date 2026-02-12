import { prisma } from "@/lib/db";
import { hashString } from "@/lib/encryption";
import {
  getModelLookupKeys,
  isModelSupported,
  isModelSupportedByProvider,
  getAllModelsWithAliases,
  getProvidersForModel,
  resolveModelAlias,
} from "./models";

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
  const provider = modelParam.substring(0, slashIndex);
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

  const disabledModel = await prisma.disabledModel.findFirst({
    where: {
      userId,
      model: { in: getModelLookupKeys(baseValidation.model) },
    },
    select: { id: true },
  });

  if (disabledModel) {
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
    return { valid: false, error: "Invalid API key" };
  }

  if (!apiKey.isActive) {
    return { valid: false, error: "API key has been revoked" };
  }

  // Check if key has expired
  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
    return { valid: false, error: "API key has expired" };
  }

  // Update last used timestamp
  await prisma.proxyApiKey.update({
    where: { id: apiKey.id },
    data: { lastUsedAt: new Date() },
  });

  const modelAccessMode = normalizeApiKeyModelAccessMode(apiKey.modelAccessMode);
  const modelAccessList = normalizeApiKeyModelList(apiKey.modelAccessList);

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
  } catch (error) {
    console.error("Failed to log usage:", error);
  }
}
