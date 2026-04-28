import { db } from "@opendum/shared/db";
import { providerAccount } from "@opendum/shared/db/schema";
import { encrypt, hashString } from "@opendum/shared/encryption";
import { getProviderModelMap } from "@opendum/shared/proxy/models";
import { API_BASE_URL as cerebrasApiBaseUrl } from "@opendum/shared/proxy/providers/cerebras/constants";
import { API_BASE_URL as groqApiBaseUrl } from "@opendum/shared/proxy/providers/groq/constants";
import { API_BASE_URL as kiloCodeApiBaseUrl } from "@opendum/shared/proxy/providers/kilo-code/constants";
import { API_BASE_URL as nvidiaApiBaseUrl } from "@opendum/shared/proxy/providers/nvidia-nim/constants";
import { API_BASE_URL as ollamaApiBaseUrl } from "@opendum/shared/proxy/providers/ollama-cloud/constants";
import { API_BASE_URL as openRouterApiBaseUrl } from "@opendum/shared/proxy/providers/openrouter/constants";
import { getWorkersAiValidationUrl } from "@opendum/shared/proxy/providers/workers-ai/constants";
import { and, asc, count as countFn, eq } from "drizzle-orm";
import { z } from "zod";

import { protectedProcedure, type ActionResult } from "../../init";

const API_KEY_PROVIDER_ACCOUNT_EXPIRY = new Date("2100-01-01T00:00:00.000Z");
const API_KEY_VALIDATION_TIMEOUT_MS = 15000;

const apiKeyProviderSchema = z.enum(["nvidia_nim", "ollama_cloud", "openrouter", "groq", "cerebras", "kilo_code"]);
type ApiKeyProvider = z.infer<typeof apiKeyProviderSchema>;

const API_KEY_PROVIDER_SETTINGS = {
  nvidia_nim: { label: "Nvidia", baseUrl: nvidiaApiBaseUrl, modelMap: getProviderModelMap("nvidia_nim"), validationPath: "/chat/completions", requireSuccessfulStatus: false },
  ollama_cloud: { label: "Ollama Cloud", baseUrl: ollamaApiBaseUrl, modelMap: getProviderModelMap("ollama_cloud"), validationPath: "/chat/completions", requireSuccessfulStatus: false },
  openrouter: { label: "OpenRouter", baseUrl: openRouterApiBaseUrl, modelMap: getProviderModelMap("openrouter"), validationPath: "/models", requireSuccessfulStatus: true },
  groq: { label: "Groq", baseUrl: groqApiBaseUrl, modelMap: getProviderModelMap("groq"), validationPath: "/models", requireSuccessfulStatus: true },
  cerebras: { label: "Cerebras", baseUrl: cerebrasApiBaseUrl, modelMap: getProviderModelMap("cerebras"), validationPath: "/models", requireSuccessfulStatus: true },
  kilo_code: { label: "Kilo Code", baseUrl: kiloCodeApiBaseUrl, modelMap: getProviderModelMap("kilo_code"), validationPath: "/models", requireSuccessfulStatus: true },
} satisfies Record<ApiKeyProvider, { label: string; baseUrl: string; modelMap: Record<string, string>; validationPath: string; requireSuccessfulStatus: boolean }>;

async function validateProviderApiKey(provider: ApiKeyProvider, apiKey: string): Promise<ActionResult<void>> {
  const { label, baseUrl, modelMap, validationPath, requireSuccessfulStatus } = API_KEY_PROVIDER_SETTINGS[provider];
  const validationModel = Object.values(modelMap)[0];
  if (validationPath === "/chat/completions" && !validationModel) return { success: false, error: `${label} API key validation model is not configured.` };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_KEY_VALIDATION_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${validationPath}`, { method: validationPath === "/chat/completions" ? "POST" : "GET", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" }, signal: controller.signal, cache: "no-store", body: validationPath === "/chat/completions" ? JSON.stringify({ model: validationModel, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }) : undefined });
    let responseText = "";
    if (response.status === 401 || response.status === 403 || (requireSuccessfulStatus && !response.ok)) {
      try { responseText = await response.text(); } catch { responseText = ""; }
    }
    if (response.status === 401 || response.status === 403) return { success: false, error: `${label} API key is invalid.` };
    if (requireSuccessfulStatus && !response.ok) {
      const normalizedBody = responseText.toLowerCase();
      if (normalizedBody.includes("authenticate") || normalizedBody.includes("unauthorized") || normalizedBody.includes("invalid api key") || normalizedBody.includes("user not found")) {
        return { success: false, error: `${label} API key is invalid.` };
      }
      return { success: false, error: `Unable to validate ${label} API key right now (HTTP ${response.status}). Please try again.` };
    }
    return { success: true, data: undefined };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return { success: false, error: `${label} API key validation timed out. Please try again.` };
    return { success: false, error: `Unable to validate ${label} API key. Please check your network and try again.` };
  } finally {
    clearTimeout(timeout);
  }
}

async function connectApiKeyProviderAccount(userId: string, provider: ApiKeyProvider, apiKey: string, accountName?: string): Promise<ActionResult<{ email: string; isUpdate: boolean }>> {
  const normalizedApiKey = apiKey.trim();
  if (!normalizedApiKey) return { success: false, error: "API key is required" };
  const validationResult = await validateProviderApiKey(provider, normalizedApiKey);
  if (!validationResult.success) return validationResult;

  const { label } = API_KEY_PROVIDER_SETTINGS[provider];
  const identifier = `${provider}-${hashString(normalizedApiKey).slice(0, 16)}`;
  const normalizedAccountName = accountName?.trim();
  const [existingAccount] = await db.select().from(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, provider), eq(providerAccount.email, identifier))).limit(1);

  if (existingAccount) {
    await db.update(providerAccount).set({ accessToken: encrypt(normalizedApiKey), refreshToken: encrypt(normalizedApiKey), expiresAt: API_KEY_PROVIDER_ACCOUNT_EXPIRY, ...(normalizedAccountName ? { name: normalizedAccountName } : {}), isActive: true }).where(eq(providerAccount.id, existingAccount.id));
    return { success: true, data: { email: identifier, isUpdate: true } };
  }

  const [countResult] = await db.select({ value: countFn() }).from(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, provider)));
  await db.insert(providerAccount).values({ userId, provider, name: normalizedAccountName || `${label} ${(countResult?.value ?? 0) + 1}`, accessToken: encrypt(normalizedApiKey), refreshToken: encrypt(normalizedApiKey), expiresAt: API_KEY_PROVIDER_ACCOUNT_EXPIRY, email: identifier, isActive: true });

  return { success: true, data: { email: identifier, isUpdate: false } };
}

async function connectWorkersAi(userId: string, apiToken: string, cfAccountId: string, accountName?: string): Promise<ActionResult<{ email: string; isUpdate: boolean }>> {
  const normalizedApiToken = apiToken.trim();
  const normalizedAccountId = cfAccountId.trim();
  if (!normalizedApiToken) return { success: false, error: "API token is required" };
  if (!normalizedAccountId) return { success: false, error: "Cloudflare Account ID is required" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_KEY_VALIDATION_TIMEOUT_MS);
  try {
    const response = await fetch(getWorkersAiValidationUrl(normalizedAccountId), { method: "GET", headers: { Authorization: `Bearer ${normalizedApiToken}`, Accept: "application/json" }, signal: controller.signal, cache: "no-store" });
    if (response.status === 401 || response.status === 403) return { success: false, error: "Workers AI API token is invalid." };
    if (!response.ok) return { success: false, error: `Unable to validate Workers AI credentials (HTTP ${response.status}). Please try again.` };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return { success: false, error: "Workers AI validation timed out. Please try again." };
    return { success: false, error: "Unable to validate Workers AI credentials. Please check your network and try again." };
  } finally {
    clearTimeout(timeout);
  }

  const identifier = `workers_ai-${hashString(normalizedApiToken).slice(0, 16)}`;
  const normalizedAccountName = accountName?.trim();
  const [existingAccount] = await db.select().from(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, "workers_ai"), eq(providerAccount.email, identifier))).limit(1);
  if (existingAccount) {
    await db.update(providerAccount).set({ accessToken: encrypt(normalizedApiToken), refreshToken: encrypt(normalizedApiToken), expiresAt: API_KEY_PROVIDER_ACCOUNT_EXPIRY, accountId: normalizedAccountId, ...(normalizedAccountName ? { name: normalizedAccountName } : {}), isActive: true }).where(eq(providerAccount.id, existingAccount.id));
    return { success: true, data: { email: identifier, isUpdate: true } };
  }

  const [countResult] = await db.select({ value: countFn() }).from(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, "workers_ai")));
  await db.insert(providerAccount).values({ userId, provider: "workers_ai", name: normalizedAccountName || `Workers AI ${(countResult?.value ?? 0) + 1}`, accessToken: encrypt(normalizedApiToken), refreshToken: encrypt(normalizedApiToken), expiresAt: API_KEY_PROVIDER_ACCOUNT_EXPIRY, email: identifier, accountId: normalizedAccountId, isActive: true });
  return { success: true, data: { email: identifier, isUpdate: false } };
}

export const listAccountsProcedure = protectedProcedure.query(async ({ ctx }) => {
    try {
      return await db
        .select({
          id: providerAccount.id,
          provider: providerAccount.provider,
          name: providerAccount.name,
          email: providerAccount.email,
          isActive: providerAccount.isActive,
          lastUsedAt: providerAccount.lastUsedAt,
          requestCount: providerAccount.requestCount,
          tier: providerAccount.tier,
          status: providerAccount.status,
          statusReason: providerAccount.statusReason,
          lastErrorAt: providerAccount.lastErrorAt,
          lastErrorMessage: providerAccount.lastErrorMessage,
          lastErrorCode: providerAccount.lastErrorCode,
          createdAt: providerAccount.createdAt,
        })
        .from(providerAccount)
        .where(eq(providerAccount.userId, ctx.userId))
        .orderBy(asc(providerAccount.createdAt));
    } catch (error) {
      console.error("Failed to list accounts:", error);
      throw new Error("Failed to list accounts");
    }
  });

export const byProviderAccountsProcedure = protectedProcedure.input(z.object({ provider: z.string() })).query(async ({ ctx, input }) => {
    try {
      return await db
        .select({
          id: providerAccount.id,
          provider: providerAccount.provider,
          name: providerAccount.name,
          email: providerAccount.email,
          isActive: providerAccount.isActive,
          lastUsedAt: providerAccount.lastUsedAt,
          requestCount: providerAccount.requestCount,
          tier: providerAccount.tier,
          status: providerAccount.status,
          statusReason: providerAccount.statusReason,
          lastErrorAt: providerAccount.lastErrorAt,
          lastErrorMessage: providerAccount.lastErrorMessage,
          lastErrorCode: providerAccount.lastErrorCode,
          createdAt: providerAccount.createdAt,
        })
        .from(providerAccount)
        .where(and(eq(providerAccount.userId, ctx.userId), eq(providerAccount.provider, input.provider)))
        .orderBy(asc(providerAccount.createdAt));
    } catch (error) {
      console.error("Failed to list provider accounts:", error);
      throw new Error("Failed to list provider accounts");
    }
  });

export const createAccountProcedure = protectedProcedure.input(z.object({ provider: z.string(), name: z.string().optional(), token: z.string(), cfAccountId: z.string().optional() })).mutation(async ({ ctx, input }) => {
    const parsedProvider = apiKeyProviderSchema.safeParse(input.provider);
    if (parsedProvider.success) {
      return connectApiKeyProviderAccount(ctx.userId, parsedProvider.data, input.token, input.name);
    }

    if (input.provider === "workers_ai") {
      return connectWorkersAi(ctx.userId, input.token, input.cfAccountId ?? "", input.name);
    }

    return { success: false, error: `${input.provider} does not support direct API-key connection.` } as const;
  });
