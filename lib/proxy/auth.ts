import { prisma } from "@/lib/db";
import { hashString } from "@/lib/encryption";
import {
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
  modelParam: string
): Promise<ModelValidationResult> {
  const baseValidation = validateModel(modelParam);

  if (!baseValidation.valid) {
    return baseValidation;
  }

  const disabledModel = await prisma.disabledModel.findUnique({
    where: {
      userId_model: {
        userId,
        model: baseValidation.model,
      },
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

  return baseValidation;
}

/**
 * Validate proxy API key and return user info
 */
export async function validateApiKey(authHeader: string | null): Promise<{
  valid: boolean;
  userId?: string;
  apiKeyId?: string;
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
    include: { user: true },
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

  return {
    valid: true,
    userId: apiKey.userId,
    apiKeyId: apiKey.id,
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
  provider?: string; // Optional: for quota tracking
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

    // Track quota for Antigravity requests (only successful requests)
    if (
      params.provider === "antigravity" &&
      params.providerAccountId &&
      params.statusCode &&
      params.statusCode >= 200 &&
      params.statusCode < 300
    ) {
      try {
        // Dynamic import to avoid circular dependencies
        const { incrementRequestCount } = await import(
          "@/lib/proxy/providers/antigravity/quota-cache"
        );
        incrementRequestCount(params.providerAccountId, params.model);
      } catch {
        // Ignore quota tracking errors
      }
    }
  } catch (error) {
    console.error("Failed to log usage:", error);
  }
}
