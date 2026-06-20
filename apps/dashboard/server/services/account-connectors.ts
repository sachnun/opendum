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
import { API_BASE_URL as commandCodeApiBaseUrl, GENERATE_PATH as commandCodeGeneratePath } from "../lib/providers/commandcode/constants";
import { formatProviderHttpError, isLikelyCloudflareChallenge } from "../lib/providers/provider-http-errors";
import { getCloudflareValidationUrl } from "../lib/providers/cloudflare/constants";
import type { ActionResult } from "../utils/api";

const API_KEY_PROVIDER_ACCOUNT_EXPIRY = new Date("2100-01-01T00:00:00.000Z");
const API_KEY_VALIDATION_TIMEOUT_MS = 15000;
const INTERNAL_RELAY_ERROR_HEADER = "X-Opendum-Internal-Relay-Error";

const apiKeyProviderSchema = z.enum(["nvidia_nim", "openrouter", "qoder", "siliconflow", "zenmux", "command_code"]);
export const createAccountInputSchema = z.object({ provider: z.string(), name: z.string().optional(), token: z.string(), cfAccountId: z.string().optional() });
type ApiKeyProvider = z.infer<typeof apiKeyProviderSchema>;
type CreateAccountInput = z.infer<typeof createAccountInputSchema>;

const API_KEY_PROVIDER_SETTINGS = {
  nvidia_nim: { label: "Nvidia", baseUrl: nvidiaApiBaseUrl, modelMap: getProviderModelMap("nvidia_nim"), validationPath: "/chat/completions", requireSuccessfulStatus: false },
  openrouter: { label: "OpenRouter", baseUrl: openRouterApiBaseUrl, modelMap: getProviderModelMap("openrouter"), validationPath: "/models", requireSuccessfulStatus: true },
  qoder: { label: "Qoder", baseUrl: "https://openapi.qoder.sh/api/v1", modelMap: getProviderModelMap("qoder"), validationPath: "/models", requireSuccessfulStatus: true },
  siliconflow: { label: "SiliconFlow", baseUrl: siliconflowApiBaseUrl, modelMap: getProviderModelMap("siliconflow"), validationPath: "/models", requireSuccessfulStatus: true },
  zenmux: { label: "ZenMux", baseUrl: zenmuxApiBaseUrl, modelMap: getProviderModelMap("zenmux"), validationPath: "/chat/completions", requireSuccessfulStatus: false },
  command_code: { label: "Command Code", baseUrl: commandCodeApiBaseUrl, modelMap: getProviderModelMap("command_code"), validationPath: commandCodeGeneratePath, requireSuccessfulStatus: false },
} satisfies Record<ApiKeyProvider, { label: string; baseUrl: string; modelMap: Record<string, string>; validationPath: "/models" | "/chat/completions" | "/alpha/generate"; requireSuccessfulStatus: boolean }>;

// Command Code's Go tier uses the reverse-engineered CLI /alpha/generate
// endpoint, which takes a custom CLI envelope (not an OpenAI body).
const COMMAND_CODE_CLI_VERSION = "0.38.7";

// Canonical Tier IDs stored on providerAccount.tier. These mirror the
// labels rendered by the Go proxy fetcher in quota_commandcode.go so the
// account record stays in sync with the live /alpha/billing/subscriptions
// response. Paid plans surface a non-null planId string ("individual-go",
// "individual-pro"); free / un-subscribed accounts surface planId: null and
// are stamped "free" so downstream model-access rules see them explicitly
// rather than guessing from empty credits.
function commandCodeCanonicalTier(planId: string | null | undefined): string | undefined {
  if (planId == null) return "free";
  const cleaned = planId.toLowerCase().trim();
  if (!cleaned) return "free";
  switch (cleaned) {
    case "individual-go":
      return "go";
    default:
      return undefined;
  }
}

async function fetchCommandCodePlanTier(apiKey: string): Promise<string | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_KEY_VALIDATION_TIMEOUT_MS);
  try {
    const response = await fetchInternalProvider(commandCodeApiBaseUrl + "/alpha/billing/subscriptions", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (response.headers.get(INTERNAL_RELAY_ERROR_HEADER) === "1") return undefined;
    if (!response.ok) return undefined;
    const payload = (await response.json().catch(() => null)) as { data?: { planId?: string | null } } | null;
    const rawPlanId = (payload?.data?.planId ?? null) as string | null;
    return commandCodeCanonicalTier(rawPlanId);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

function buildCommandCodeValidationEnvelope(model: string) {
  return {
    config: { workingDir: "/", date: new Date().toISOString().slice(0, 10), environment: "linux-x64", structure: [], isGitRepo: false, currentBranch: "", mainBranch: "", gitStatus: "", recentCommits: [] },
    memory: "",
    taste: "",
    skills: null,
    permissionMode: "standard",
    params: { model, messages: [{ role: "user", content: "ping" }], stream: true, max_tokens: 1 },
  };
}

function buildValidationRequest(provider: ApiKeyProvider, apiKey: string) {
  const { baseUrl, modelMap, validationPath } = API_KEY_PROVIDER_SETTINGS[provider];
  const validationModel = Object.values(modelMap)[0];
  const isCommandCode = provider === "command_code";
  const isPost = validationPath === "/chat/completions" || isCommandCode;
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" };
  let body: Record<string, unknown> | undefined;
  if (isCommandCode) {
    headers["x-command-code-version"] = COMMAND_CODE_CLI_VERSION;
    headers["x-cli-environment"] = "production";
    headers["x-project-slug"] = "command-code";
    headers["Accept"] = "text/event-stream";
    body = buildCommandCodeValidationEnvelope(validationModel as string);
  } else if (validationPath === "/chat/completions") {
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

async function validateProviderApiKey(provider: ApiKeyProvider, apiKey: string): Promise<ActionResult<void>> {
  const { label, validationPath, requireSuccessfulStatus } = API_KEY_PROVIDER_SETTINGS[provider];
  const { validationModel, url, method, headers, body } = buildValidationRequest(provider, apiKey);
  if ((validationPath === "/chat/completions" || provider === "command_code") && !validationModel) return { success: false, error: `${label} API key validation model is not configured.` };

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
    // Command Code validates against a streaming endpoint; release the SSE
    // body once auth is confirmed so the request does not leak a connection.
    if (provider === "command_code" && response.body) {
      try { await response.body.cancel(); } catch { /* noop */ }
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
  // Command Code stamps the actual plan tier so downstream model-access
  // rules (open-source-only on the Go tier, premium allowed on Pro/Max)
  // resolve correctly. We resolve the tier from the live
  // /alpha/billing/subscriptions endpoint; unknown planIds are left
  // undefined so model-access rules receive an empty tier and decide for
  // themselves rather than getting a misleading "go" stamp.
  const tier = provider === "command_code" ? await fetchCommandCodePlanTier(normalizedApiKey) : undefined;
  const [existingAccount] = await db.select().from(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, provider), eq(providerAccount.email, identifier))).limit(1);
  if (existingAccount) {
    await db.update(providerAccount).set({ accessToken: encrypt(normalizedApiKey), refreshToken: encrypt(normalizedApiKey), expiresAt: API_KEY_PROVIDER_ACCOUNT_EXPIRY, ...(normalizedAccountName ? { name: normalizedAccountName } : {}), ...(tier ? { tier } : {}), isActive: true, disabledUntil: null }).where(eq(providerAccount.id, existingAccount.id));
    return { success: true, data: { email: identifier, isUpdate: true } };
  }

  const [countResult] = await db.select({ value: countFn() }).from(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, provider)));
  await db.insert(providerAccount).values({ userId, provider, name: normalizedAccountName || `${label} ${(countResult?.value ?? 0) + 1}`, accessToken: encrypt(normalizedApiKey), refreshToken: encrypt(normalizedApiKey), expiresAt: API_KEY_PROVIDER_ACCOUNT_EXPIRY, email: identifier, isActive: true, ...(tier ? { tier } : {}) });
  return { success: true, data: { email: identifier, isUpdate: false } };
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
  ...Object.fromEntries(apiKeyProviderSchema.options.map((provider) => [provider, (userId: string, input: CreateAccountInput) => connectApiKeyProviderAccount(userId, provider, input.token, input.name)])),
  workers_ai: (userId: string, input: CreateAccountInput) => connectCloudflare(userId, input.token, input.cfAccountId ?? "", input.name),
} as Record<string, (userId: string, input: CreateAccountInput) => Promise<ActionResult<{ email: string; isUpdate: boolean }>>>;

export async function createAccount(userId: string, input: CreateAccountInput) {
  return ACCOUNT_CONNECTORS[input.provider]?.(userId, input) ?? { success: false, error: `${input.provider} does not support direct API-key connection.` } as const;
}
