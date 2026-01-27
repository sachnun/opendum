import { prisma } from "@/lib/db";
import { hashString } from "@/lib/encryption";
import { isModelSupported, getAllModelsWithAliases } from "./models";

/**
 * Validate model parameter against available models
 */
export function validateModel(model: string): {
  valid: boolean;
  error?: string;
  param?: string;
  code?: string;
} {
  if (!isModelSupported(model)) {
    const allModels = getAllModelsWithAliases();
    return {
      valid: false,
      error: `Invalid model: ${model}. Available models: ${allModels.sort().join(", ")}`,
      param: "model",
      code: "invalid_model",
    };
  }
  return { valid: true };
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
