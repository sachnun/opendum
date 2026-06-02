import { and, count as countFn, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { providerAccount } from "../lib/db/schema";
import { encrypt, hashString } from "../lib/encryption";
import { fetchInternalProvider, InternalRelayNotConfiguredError } from "../lib/proxy/internal-relay";
import { getProviderModelMap } from "../lib/proxy/models";
import { API_BASE_URL as nvidiaApiBaseUrl } from "../lib/providers/nvidia-nim/constants";
import { API_BASE_URL as openRouterApiBaseUrl } from "../lib/providers/openrouter/constants";
import { formatProviderHttpError, isLikelyCloudflareChallenge } from "../lib/providers/provider-http-errors";
import { getWorkersAiValidationUrl } from "../lib/providers/workers-ai/constants";
import type { ActionResult } from "../utils/api";

const API_KEY_PROVIDER_ACCOUNT_EXPIRY = new Date("2100-01-01T00:00:00.000Z");
const API_KEY_VALIDATION_TIMEOUT_MS = 15000;
const INTERNAL_RELAY_ERROR_HEADER = "X-Opendum-Internal-Relay-Error";

const apiKeyProviderSchema = z.enum(["nvidia_nim", "openrouter"]);
export const createAccountInputSchema = z.object({ provider: z.string(), name: z.string().optional(), token: z.string(), cfAccountId: z.string().optional() });
type ApiKeyProvider = z.infer<typeof apiKeyProviderSchema>;
type CreateAccountInput = z.infer<typeof createAccountInputSchema>;

const API_KEY_PROVIDER_SETTINGS = {
  nvidia_nim: { label: "Nvidia", baseUrl: nvidiaApiBaseUrl, modelMap: getProviderModelMap("nvidia_nim"), validationPath: "/chat/completions", requireSuccessfulStatus: false },
  openrouter: { label: "Openrouter", baseUrl: openRouterApiBaseUrl, modelMap: getProviderModelMap("openrouter"), validationPath: "/models", requireSuccessfulStatus: true },
} satisfies Record<ApiKeyProvider, { label: string; baseUrl: string; modelMap: Record<string, string>; validationPath: "/models" | "/chat/completions"; requireSuccessfulStatus: boolean }>;

function buildValidationRequest(provider: ApiKeyProvider, apiKey: string) {
  const { baseUrl, modelMap, validationPath } = API_KEY_PROVIDER_SETTINGS[provider];
  const validationModel = Object.values(modelMap)[0];
  const isChatValidation = validationPath === "/chat/completions";
  return {
    validationModel,
    url: `${baseUrl}${validationPath}`,
    method: isChatValidation ? "POST" as const : "GET" as const,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
    body: isChatValidation ? { model: validationModel, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false } : undefined,
  };
}

async function validateProviderApiKey(provider: ApiKeyProvider, apiKey: string): Promise<ActionResult<void>> {
  const { label, validationPath, requireSuccessfulStatus } = API_KEY_PROVIDER_SETTINGS[provider];
  const { validationModel, url, method, headers, body } = buildValidationRequest(provider, apiKey);
  if (validationPath === "/chat/completions" && !validationModel) return { success: false, error: `${label} API key validation model is not configured.` };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_KEY_VALIDATION_TIMEOUT_MS);
  try {
    const response = await fetchInternalProvider(url, { method, headers, body, signal: controller.signal });
    if (response.headers.get(INTERNAL_RELAY_ERROR_HEADER) === "1") return { success: false, error: `Unable to validate ${label} API key through the proxy. Please try again.` };
    let responseText = "";
    if (!response.ok) {
      try { responseText = await response.text(); } catch { responseText = ""; }
    }
    if (isLikelyCloudflareChallenge(response, responseText)) return { success: false, error: formatProviderHttpError(label, response, responseText, { endpointLabel: "API key validation endpoint" }) };
    if (response.status === 401 || response.status === 403) return { success: false, error: `${label} API key is invalid.` };
    if (requireSuccessfulStatus && !response.ok) {
      const normalizedBody = responseText.toLowerCase();
      if (normalizedBody.includes("authenticate") || normalizedBody.includes("unauthorized") || normalizedBody.includes("invalid api key") || normalizedBody.includes("user not found")) return { success: false, error: `${label} API key is invalid.` };
      return { success: false, error: `Unable to validate ${label} API key right now (HTTP ${response.status}). Please try again.` };
    }
    return { success: true, data: undefined };
  } catch (error) {
    if (error instanceof InternalRelayNotConfiguredError) return { success: false, error: "Proxy URL is required to validate external provider API keys. Set NUXT_PUBLIC_PROXY_URL to your Railway proxy URL." };
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
    await db.update(providerAccount).set({ accessToken: encrypt(normalizedApiKey), refreshToken: encrypt(normalizedApiKey), expiresAt: API_KEY_PROVIDER_ACCOUNT_EXPIRY, ...(normalizedAccountName ? { name: normalizedAccountName } : {}), isActive: true, disabledUntil: null }).where(eq(providerAccount.id, existingAccount.id));
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
    const response = await fetchInternalProvider(getWorkersAiValidationUrl(normalizedAccountId), { method: "GET", headers: { Authorization: `Bearer ${normalizedApiToken}`, Accept: "application/json" }, signal: controller.signal });
    if (response.headers.get(INTERNAL_RELAY_ERROR_HEADER) === "1") return { success: false, error: "Unable to validate Workers AI credentials through the proxy. Please try again." };
    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      if (isLikelyCloudflareChallenge(response, responseText)) return { success: false, error: formatProviderHttpError("Workers AI", response, responseText, { endpointLabel: "credentials validation endpoint" }) };
      if (response.status === 401 || response.status === 403) return { success: false, error: "Workers AI API token is invalid." };
      return { success: false, error: `Unable to validate Workers AI credentials (HTTP ${response.status}). Please try again.` };
    }
  } catch (error) {
    if (error instanceof InternalRelayNotConfiguredError) return { success: false, error: "Proxy URL is required to validate Workers AI credentials. Set NUXT_PUBLIC_PROXY_URL to your Railway proxy URL." };
    if (error instanceof Error && error.name === "AbortError") return { success: false, error: "Workers AI validation timed out. Please try again." };
    return { success: false, error: "Unable to validate Workers AI credentials. Please check your network and try again." };
  } finally {
    clearTimeout(timeout);
  }

  const identifier = `workers_ai-${hashString(`${normalizedAccountId}:${normalizedApiToken}`).slice(0, 16)}`;
  const normalizedAccountName = accountName?.trim();
  const [existingAccount] = await db.select().from(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, "workers_ai"), eq(providerAccount.email, identifier))).limit(1);
  if (existingAccount) {
    await db.update(providerAccount).set({ accessToken: encrypt(normalizedApiToken), refreshToken: encrypt(normalizedApiToken), expiresAt: API_KEY_PROVIDER_ACCOUNT_EXPIRY, accountId: normalizedAccountId, ...(normalizedAccountName ? { name: normalizedAccountName } : {}), isActive: true, disabledUntil: null }).where(eq(providerAccount.id, existingAccount.id));
    return { success: true, data: { email: identifier, isUpdate: true } };
  }

  const [countResult] = await db.select({ value: countFn() }).from(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, "workers_ai")));
  await db.insert(providerAccount).values({ userId, provider: "workers_ai", name: normalizedAccountName || `Workers AI ${(countResult?.value ?? 0) + 1}`, accessToken: encrypt(normalizedApiToken), refreshToken: encrypt(normalizedApiToken), expiresAt: API_KEY_PROVIDER_ACCOUNT_EXPIRY, email: identifier, accountId: normalizedAccountId, isActive: true });
  return { success: true, data: { email: identifier, isUpdate: false } };
}

const ACCOUNT_CONNECTORS = {
  ...Object.fromEntries(apiKeyProviderSchema.options.map((provider) => [provider, (userId: string, input: CreateAccountInput) => connectApiKeyProviderAccount(userId, provider, input.token, input.name)])),
  workers_ai: (userId: string, input: CreateAccountInput) => connectWorkersAi(userId, input.token, input.cfAccountId ?? "", input.name),
} as Record<string, (userId: string, input: CreateAccountInput) => Promise<ActionResult<{ email: string; isUpdate: boolean }>>>;

export async function createAccount(userId: string, input: CreateAccountInput) {
  return ACCOUNT_CONNECTORS[input.provider]?.(userId, input) ?? { success: false, error: `${input.provider} does not support direct API-key connection.` } as const;
}
