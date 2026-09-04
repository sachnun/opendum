import { and, count as countFn, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { providerAccount } from "../lib/db/schema";
import { encrypt, hashString } from "../lib/encryption";
import { fetchInternalProvider, InternalRelayNotConfiguredError } from "../lib/proxy/internal-relay";
import { getProviderModelMap } from "../lib/proxy/models";
import { API_BASE_URL as nvidiaApiBaseUrl } from "../lib/providers/nvidia/constants";
import { API_BASE_URL as openRouterApiBaseUrl } from "../lib/providers/openrouter/constants";
import { API_BASE_URL as siliconflowApiBaseUrl } from "../lib/providers/siliconflow/constants";
import { API_BASE_URL as zenmuxApiBaseUrl } from "../lib/providers/zenmux/constants";
import { API_BASE_URL as harborApiBaseUrl } from "../lib/providers/harbor/constants";
import { formatProviderHttpError, isLikelyCloudflareChallenge } from "../lib/providers/provider-http-errors";
import { getCloudflareValidationUrl } from "../lib/providers/cloudflare/constants";
import { API_KEY_PROVIDER_KEYS, type ApiKeyProviderKey } from "../../lib/provider-accounts";
import type { ActionResult } from "../utils/api";

const API_KEY_PROVIDER_ACCOUNT_EXPIRY = new Date("2100-01-01T00:00:00.000Z");
const API_KEY_VALIDATION_TIMEOUT_MS = 15000;
const INTERNAL_RELAY_ERROR_HEADER = "X-Opendum-Internal-Relay-Error";

const apiKeyProviderSchema = z.enum([...API_KEY_PROVIDER_KEYS]);
export const createAccountInputSchema = z.object({ provider: z.string(), name: z.string().optional(), token: z.string(), cfAccountId: z.string().optional(), platformKey: z.string().optional() });
type CreateAccountInput = z.infer<typeof createAccountInputSchema>;

const API_KEY_PROVIDER_SETTINGS = {
  nvidia_nim: { label: "Nvidia", baseUrl: nvidiaApiBaseUrl, modelMap: getProviderModelMap("nvidia_nim"), validationPath: "/chat/completions", requireSuccessfulStatus: false },
  openrouter: { label: "OpenRouter", baseUrl: openRouterApiBaseUrl, modelMap: getProviderModelMap("openrouter"), validationPath: "/models", requireSuccessfulStatus: true },
  siliconflow: { label: "SiliconFlow", baseUrl: siliconflowApiBaseUrl, modelMap: getProviderModelMap("siliconflow"), validationPath: "/models", requireSuccessfulStatus: true },
  zenmux: { label: "ZenMux", baseUrl: zenmuxApiBaseUrl, modelMap: getProviderModelMap("zenmux"), validationPath: "/chat/completions", requireSuccessfulStatus: false },
  harbor: { label: "Harbor", baseUrl: harborApiBaseUrl, modelMap: getProviderModelMap("harbor"), validationPath: "/models", requireSuccessfulStatus: true },
} satisfies Record<ApiKeyProviderKey, { label: string; baseUrl: string; modelMap: Record<string, string>; validationPath: "/models" | "/chat/completions"; requireSuccessfulStatus: boolean }>;

function buildValidationRequest(provider: ApiKeyProviderKey, apiKey: string) {
  const { baseUrl, modelMap, validationPath } = API_KEY_PROVIDER_SETTINGS[provider];
  const validationModel = Object.values(modelMap)[0];
  const isPost = validationPath === "/chat/completions";
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" };
  let body: Record<string, unknown> | undefined;
  if (validationPath === "/chat/completions") {
    body = { model: validationModel, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false };
  }
  return {
    validationModel,
    url: `${baseUrl}${validationPath}`,
    method: (isPost ? "POST" : "GET") as "POST" | "GET",
    headers,
    body,
  };
}

async function validateProviderApiKey(provider: ApiKeyProviderKey, apiKey: string): Promise<ActionResult<void>> {
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

async function connectApiKeyProviderAccount(userId: string, provider: ApiKeyProviderKey, apiKey: string, accountName?: string, platformKey?: string): Promise<ActionResult<{ email: string; isUpdate: boolean }>> {
  const normalizedApiKey = apiKey.trim();
  if (!normalizedApiKey) return { success: false, error: "API key is required" };
  const validationResult = await validateProviderApiKey(provider, normalizedApiKey);
  if (!validationResult.success) return validationResult;

  const { label } = API_KEY_PROVIDER_SETTINGS[provider];
  const identifier = `${provider}-${hashString(normalizedApiKey).slice(0, 16)}`;
  const normalizedAccountName = accountName?.trim();
  const normalizedPlatformKey = platformKey?.trim() || null;
  const [existingAccount] = await db.select().from(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, provider), eq(providerAccount.email, identifier))).limit(1);
  if (existingAccount) {
    await db.update(providerAccount).set({ accessToken: encrypt(normalizedApiKey), refreshToken: encrypt(normalizedApiKey), expiresAt: API_KEY_PROVIDER_ACCOUNT_EXPIRY, ...(normalizedAccountName ? { name: normalizedAccountName } : {}), ...(normalizedPlatformKey ? { accountId: normalizedPlatformKey } : {}), isActive: true, disabledUntil: null }).where(eq(providerAccount.id, existingAccount.id));
    return { success: true, data: { email: identifier, isUpdate: true } };
  }

  const [countResult] = await db.select({ value: countFn() }).from(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, provider)));
  await db.insert(providerAccount).values({ userId, provider, name: normalizedAccountName || `${label} ${(countResult?.value ?? 0) + 1}`, accessToken: encrypt(normalizedApiKey), refreshToken: encrypt(normalizedApiKey), expiresAt: API_KEY_PROVIDER_ACCOUNT_EXPIRY, email: identifier, ...(normalizedPlatformKey ? { accountId: normalizedPlatformKey } : {}), isActive: true });
  return { success: true, data: { email: identifier, isUpdate: false } };
}

async function connectQoderPATAccount(userId: string, pat: string, accountName?: string): Promise<ActionResult<{ email: string; isUpdate: boolean }>> {
  const normalizedPAT = pat.trim();
  if (!normalizedPAT) return { success: false, error: "API key is required" };

  // Qoder PATs cannot authenticate inference directly: they must be exchanged
  // for a short-lived session token first. The exchange doubles as
  // validation (200 -> valid PAT, 401 -> rejected).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_KEY_VALIDATION_TIMEOUT_MS);
  let exchange: { token?: string; refresh_token?: string; expires_at?: string; expires_in?: number };
  try {
    const response = await fetchInternalProvider("https://openapi.qoder.sh/api/v1/jobToken/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ personal_token: normalizedPAT }),
      signal: controller.signal,
    });
    if (response.headers.get(INTERNAL_RELAY_ERROR_HEADER) === "1") return { success: false, error: "Unable to validate Qoder API key through the proxy. Please try again." };
    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      if (response.status === 401 || response.status === 403) return { success: false, error: "Qoder API key is invalid, expired, or revoked." };
      const normalizedBody = responseText.toLowerCase();
      if (normalizedBody.includes("token is not active") || normalizedBody.includes("invalid api key") || normalizedBody.includes("unauthorized")) return { success: false, error: "Qoder API key is invalid, expired, or revoked." };
      return { success: false, error: `Unable to validate Qoder API key right now (HTTP ${response.status}). Please try again.` };
    }
    exchange = await response.json().catch(() => ({}));
  } catch (error) {
    if (error instanceof InternalRelayNotConfiguredError) return { success: false, error: "Proxy URL is required to validate Qoder API keys. Set NUXT_PUBLIC_PROXY_URL to your Railway proxy URL." };
    if (error instanceof Error && error.name === "AbortError") return { success: false, error: "Qoder API key validation timed out. Please try again." };
    return { success: false, error: "Unable to validate Qoder API key. Please check your network and try again." };
  } finally {
    clearTimeout(timeout);
  }

  const accessToken = exchange.token;
  if (!accessToken) return { success: false, error: "Qoder API key exchange returned an empty session token." };
  const refreshToken = exchange.refresh_token || accessToken;

  // The exchange does not return the user id; resolve it via /userinfo so the
  // proxy can build COSY-signed inference requests later.
  let qoderUserId = "";
  let identityEmail = "";
  try {
    const userResponse = await fetchInternalProvider("https://openapi.qoder.sh/api/v1/userinfo", {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      cache: "no-store",
    });
    if (userResponse.ok) {
      const user = await userResponse.json().catch(() => ({})) as { id?: string; email?: string; username?: string };
      qoderUserId = user.id || "";
      identityEmail = user.email || user.username || "";
    }
  } catch {
    // userinfo is best-effort; the account identifier keys off the PAT hash
    // so a missing user id does not prevent persistence.
  }

  // A per-account machine_id drives COSY request signing. Generate one here
  // and persist it alongside the user id as "<user_id>|<machine_id>" in
  // accountId; the proxy unpacks both values when signing.
  const machineId = qoderUserId ? `${qoderUserId}-${hashString(normalizedPAT).slice(0, 8)}` : hashString(normalizedPAT).slice(0, 16);
  const packedAccountId = qoderUserId ? `${qoderUserId}|${machineId}` : machineId;
  const expiresAt = parseApiKeyExpiry(exchange.expires_at, exchange.expires_in);
  const identifier = identityEmail || `qoder-${hashString(normalizedPAT).slice(0, 16)}`;
  const normalizedAccountName = accountName?.trim();

  const [existingAccount] = await db.select().from(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, "qoder"), eq(providerAccount.email, identifier))).limit(1);
  if (existingAccount) {
    await db.update(providerAccount).set({ accessToken: encrypt(accessToken), refreshToken: encrypt(refreshToken), expiresAt, accountId: packedAccountId, ...(normalizedAccountName ? { name: normalizedAccountName } : {}), isActive: true, disabledUntil: null }).where(eq(providerAccount.id, existingAccount.id));
    return { success: true, data: { email: identifier, isUpdate: true } };
  }

  const [countResult] = await db.select({ value: countFn() }).from(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, "qoder")));
  await db.insert(providerAccount).values({ userId, provider: "qoder", name: normalizedAccountName || `Qoder ${(countResult?.value ?? 0) + 1}`, accessToken: encrypt(accessToken), refreshToken: encrypt(refreshToken), expiresAt, email: identifier, accountId: packedAccountId, isActive: true });
  return { success: true, data: { email: identifier, isUpdate: false } };
}

function parseApiKeyExpiry(expiresAtISO?: string, expiresInSeconds?: number): Date {
  if (expiresAtISO) {
    const parsed = Date.parse(expiresAtISO);
    if (Number.isFinite(parsed)) return new Date(parsed);
  }
  if (typeof expiresInSeconds === "number" && Number.isFinite(expiresInSeconds) && expiresInSeconds > 0) {
    return new Date(Date.now() + expiresInSeconds * 1000);
  }
  return new Date(Date.now() + 60 * 60 * 1000);
}

async function connectCloudflare(userId: string, apiToken: string, cfAccountId: string, accountName?: string): Promise<ActionResult<{ email: string; isUpdate: boolean }>> {
  const normalizedApiToken = apiToken.trim();
  const normalizedAccountId = cfAccountId.trim();
  if (!normalizedApiToken) return { success: false, error: "API token is required" };
  if (!normalizedAccountId) return { success: false, error: "Cloudflare Account ID is required" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_KEY_VALIDATION_TIMEOUT_MS);
  try {
    const response = await fetchInternalProvider(getCloudflareValidationUrl(normalizedAccountId), { method: "GET", headers: { Authorization: `Bearer ${normalizedApiToken}`, Accept: "application/json" }, signal: controller.signal });
    if (response.headers.get(INTERNAL_RELAY_ERROR_HEADER) === "1") return { success: false, error: "Unable to validate Cloudflare credentials through the proxy. Please try again." };
    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      if (isLikelyCloudflareChallenge(response, responseText)) return { success: false, error: formatProviderHttpError("Cloudflare", response, responseText, { endpointLabel: "credentials validation endpoint" }) };
      if (response.status === 401 || response.status === 403) return { success: false, error: "Cloudflare API token is invalid." };
      return { success: false, error: `Unable to validate Cloudflare credentials (HTTP ${response.status}). Please try again.` };
    }
  } catch (error) {
    if (error instanceof InternalRelayNotConfiguredError) return { success: false, error: "Proxy URL is required to validate Cloudflare credentials. Set NUXT_PUBLIC_PROXY_URL to your Railway proxy URL." };
    if (error instanceof Error && error.name === "AbortError") return { success: false, error: "Cloudflare validation timed out. Please try again." };
    return { success: false, error: "Unable to validate Cloudflare credentials. Please check your network and try again." };
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
  await db.insert(providerAccount).values({ userId, provider: "workers_ai", name: normalizedAccountName || `Cloudflare ${(countResult?.value ?? 0) + 1}`, accessToken: encrypt(normalizedApiToken), refreshToken: encrypt(normalizedApiToken), expiresAt: API_KEY_PROVIDER_ACCOUNT_EXPIRY, email: identifier, accountId: normalizedAccountId, isActive: true });
  return { success: true, data: { email: identifier, isUpdate: false } };
}

const ACCOUNT_CONNECTORS = {
  ...Object.fromEntries(apiKeyProviderSchema.options.map((provider) => [provider, (userId: string, input: CreateAccountInput) => connectApiKeyProviderAccount(userId, provider, input.token, input.name, input.platformKey)])),
  qoder: (userId: string, input: CreateAccountInput) => connectQoderPATAccount(userId, input.token, input.name),
  workers_ai: (userId: string, input: CreateAccountInput) => connectCloudflare(userId, input.token, input.cfAccountId ?? "", input.name),
} as Record<string, (userId: string, input: CreateAccountInput) => Promise<ActionResult<{ email: string; isUpdate: boolean }>>>;

export async function createAccount(userId: string, input: CreateAccountInput) {
  return ACCOUNT_CONNECTORS[input.provider]?.(userId, input) ?? { success: false, error: `${input.provider} does not support direct API-key connection.` } as const;
}
