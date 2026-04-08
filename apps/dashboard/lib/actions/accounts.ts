"use server";

import { getSession } from "@/lib/auth";
import { db } from "@opendum/shared/db";
import { providerAccount, providerAccountErrorHistory, providerAccountModelHealth } from "@opendum/shared/db/schema";
import { eq, and, count as countFn, asc, desc } from "drizzle-orm";
import { encrypt, decrypt, hashString } from "@opendum/shared/encryption";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { antigravityProvider } from "@opendum/shared/proxy/providers/antigravity";
import {
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_SCOPES,
} from "@opendum/shared/proxy/providers/antigravity/constants";
import { geminiCliProvider } from "@opendum/shared/proxy/providers/gemini-cli";
import {
  GEMINI_CLI_REDIRECT_URI,
  GEMINI_CLI_CLIENT_ID,
  GEMINI_CLI_SCOPES,
} from "@opendum/shared/proxy/providers/gemini-cli/constants";
import {
  initiateDeviceCodeFlow,
  pollDeviceCodeAuthorization,
} from "@opendum/shared/proxy/providers/qwen-code";
import {
  initiateCopilotDeviceCodeFlow,
  pollCopilotDeviceCodeAuthorization,
} from "@opendum/shared/proxy/providers/copilot";
import {
  initiateCodexDeviceCodeFlow,
  pollCodexDeviceCodeAuthorization,
  codexProvider,
  generateCodeVerifier,
  generateCodeChallenge,
  CODEX_CLIENT_ID,
  CODEX_OAUTH_AUTHORIZE_ENDPOINT,
  CODEX_BROWSER_REDIRECT_URI,
  CODEX_OAUTH_SCOPE,
  CODEX_ORIGINATOR,
} from "@opendum/shared/proxy/providers/codex";
import { fetchCodexQuotaFromApi } from "@opendum/shared/proxy/providers/codex/quota";
import {
  buildKiroAuthUrl,
  generateCodeVerifier as generateKiroCodeVerifier,
  kiroProvider,
  KIRO_BROWSER_REDIRECT_URI,
} from "@opendum/shared/proxy/providers/kiro";
import {
  NVIDIA_NIM_API_BASE_URL,
} from "@opendum/shared/proxy/providers/nvidia-nim/constants";
import {
  OLLAMA_CLOUD_API_BASE_URL,
} from "@opendum/shared/proxy/providers/ollama-cloud/constants";
import {
  OPENROUTER_API_BASE_URL,
} from "@opendum/shared/proxy/providers/openrouter/constants";
import {
  GROQ_API_BASE_URL,
} from "@opendum/shared/proxy/providers/groq/constants";
import {
  CEREBRAS_API_BASE_URL,
} from "@opendum/shared/proxy/providers/cerebras/constants";
import {
  KILO_CODE_API_BASE_URL,
} from "@opendum/shared/proxy/providers/kilo-code/constants";
import {
  WORKERS_AI_API_BASE_URL,
  getWorkersAiValidationUrl,
} from "@opendum/shared/proxy/providers/workers-ai/constants";
import { getProviderModelMap } from "@opendum/shared/proxy/models";

export type ActionResult<T = void> = 
  | { success: true; data: T }
  | { success: false; error: string };
export interface ProviderAccountErrorHistoryEntry {
  id: string;
  errorCode: number;
  errorMessage: string;
  createdAt: string;
}

const CODEX_OAUTH_COOKIE_NAME = "codex_oauth_ctx";
const KIRO_OAUTH_COOKIE_NAME = "kiro_oauth_ctx";

interface CodexOAuthContext {
  state: string;
  codeVerifier: string;
}

interface KiroOAuthContext {
  state: string;
  codeVerifier: string;
}

async function detectCodexTier(
  accessToken: string,
  accountId?: string | null
): Promise<string | null> {
  try {
    const quota = await fetchCodexQuotaFromApi(accessToken, accountId ?? null);
    if (quota.status !== "success") {
      return null;
    }

    const tier = quota.planType?.trim();
    return tier && tier.length > 0 ? tier : null;
  } catch {
    return null;
  }
}

function generateCodexState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

function generateKiroState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

const API_KEY_PROVIDER_ACCOUNT_EXPIRY = new Date("2100-01-01T00:00:00.000Z");
const API_KEY_VALIDATION_TIMEOUT_MS = 15000;

const API_KEY_PROVIDER_SETTINGS = {
  nvidia_nim: {
    label: "Nvidia",
    baseUrl: NVIDIA_NIM_API_BASE_URL,
    modelMap: getProviderModelMap("nvidia_nim"),
    validationPath: "/chat/completions",
    requireSuccessfulStatus: false,
  },
  ollama_cloud: {
    label: "Ollama Cloud",
    baseUrl: OLLAMA_CLOUD_API_BASE_URL,
    modelMap: getProviderModelMap("ollama_cloud"),
    validationPath: "/chat/completions",
    requireSuccessfulStatus: false,
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: OPENROUTER_API_BASE_URL,
    modelMap: getProviderModelMap("openrouter"),
    validationPath: "/models",
    requireSuccessfulStatus: true,
  },
  groq: {
    label: "Groq",
    baseUrl: GROQ_API_BASE_URL,
    modelMap: getProviderModelMap("groq"),
    validationPath: "/models",
    requireSuccessfulStatus: true,
  },
  cerebras: {
    label: "Cerebras",
    baseUrl: CEREBRAS_API_BASE_URL,
    modelMap: getProviderModelMap("cerebras"),
    validationPath: "/models",
    requireSuccessfulStatus: true,
  },
  kilo_code: {
    label: "Kilo Code",
    baseUrl: KILO_CODE_API_BASE_URL,
    modelMap: getProviderModelMap("kilo_code"),
    validationPath: "/models",
    requireSuccessfulStatus: true,
  },
};

type ApiKeyProvider = keyof typeof API_KEY_PROVIDER_SETTINGS;

async function validateProviderApiKey(
  provider: ApiKeyProvider,
  apiKey: string
): Promise<ActionResult<void>> {
  const {
    label,
    baseUrl,
    modelMap,
    validationPath = "/chat/completions",
    requireSuccessfulStatus = false,
  } = API_KEY_PROVIDER_SETTINGS[provider];
  const validationModel = Object.values(modelMap)[0];

  if (validationPath === "/chat/completions" && !validationModel) {
    return {
      success: false,
      error: `${label} API key validation model is not configured.`,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_KEY_VALIDATION_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}${validationPath}`, {
      method: validationPath === "/chat/completions" ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      signal: controller.signal,
      cache: "no-store",
      body:
        validationPath === "/chat/completions"
          ? JSON.stringify({
              model: validationModel,
              messages: [{ role: "user", content: "ping" }],
              max_tokens: 1,
              stream: false,
            })
          : undefined,
    });

    if (response.status === 401 || response.status === 403) {
      return {
        success: false,
        error: `${label} API key is invalid.`,
      };
    }

    if (requireSuccessfulStatus && !response.ok) {
      let responseText = "";
      try {
        responseText = await response.text();
      } catch {
        responseText = "";
      }

      const normalizedBody = responseText.toLowerCase();
      const looksLikeAuthFailure =
        normalizedBody.includes("authenticate") ||
        normalizedBody.includes("unauthorized") ||
        normalizedBody.includes("invalid api key") ||
        normalizedBody.includes("user not found");

      if (looksLikeAuthFailure) {
        return {
          success: false,
          error: `${label} API key is invalid.`,
        };
      }

      return {
        success: false,
        error: `Unable to validate ${label} API key right now (HTTP ${response.status}). Please try again.`,
      };
    }

    // Any non-auth response means the key is accepted by provider auth layer.
    return { success: true, data: undefined };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        success: false,
        error: `${label} API key validation timed out. Please try again.`,
      };
    }

    return {
      success: false,
      error: `Unable to validate ${label} API key. Please check your network and try again.`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function connectApiKeyProviderAccount(
  userId: string,
  provider: ApiKeyProvider,
  providerLabel: string,
  apiKey: string,
  accountName?: string
): Promise<ActionResult<{ email: string; isUpdate: boolean }>> {
  const normalizedApiKey = apiKey.trim();
  if (!normalizedApiKey) {
    return { success: false, error: "API key is required" };
  }

  const validationResult = await validateProviderApiKey(provider, normalizedApiKey);
  if (!validationResult.success) {
    return validationResult;
  }

  const identifier = `${provider}-${hashString(normalizedApiKey).slice(0, 16)}`;
  const normalizedAccountName = accountName?.trim();

  const [existingAccount] = await db.select().from(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, provider), eq(providerAccount.email, identifier))).limit(1);

  if (existingAccount) {
    await db.update(providerAccount).set({
      accessToken: encrypt(normalizedApiKey),
      refreshToken: encrypt(normalizedApiKey),
      expiresAt: API_KEY_PROVIDER_ACCOUNT_EXPIRY,
      ...(normalizedAccountName ? { name: normalizedAccountName } : {}),
      isActive: true,
    }).where(eq(providerAccount.id, existingAccount.id));

    revalidatePath("/dashboard", "layout");
    revalidatePath("/dashboard/accounts");
    revalidatePath("/dashboard/playground");

    return {
      success: true,
      data: {
        email: identifier,
        isUpdate: true,
      },
    };
  }

  const [countResult] = await db.select({ value: countFn() }).from(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, provider)));
  const accountCount = countResult.value;

  await db.insert(providerAccount).values({
    userId,
    provider,
    name: normalizedAccountName || `${providerLabel} ${accountCount + 1}`,
    accessToken: encrypt(normalizedApiKey),
    refreshToken: encrypt(normalizedApiKey),
    expiresAt: API_KEY_PROVIDER_ACCOUNT_EXPIRY,
    email: identifier,
    isActive: true,
  });

  revalidatePath("/dashboard", "layout");
  revalidatePath("/dashboard/accounts");
  revalidatePath("/dashboard/playground");

  return {
    success: true,
    data: {
      email: identifier,
      isUpdate: false,
    },
  };
}

/**
 * Delete a provider account
 */
export async function deleteProviderAccount(id: string): Promise<ActionResult> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Verify ownership
    const [account] = await db.select().from(providerAccount).where(and(eq(providerAccount.id, id), eq(providerAccount.userId, session.user.id))).limit(1);

    if (!account) {
      return { success: false, error: "Account not found" };
    }

    await db.delete(providerAccount).where(eq(providerAccount.id, id));

    revalidatePath("/dashboard/accounts");
    revalidatePath("/dashboard/accounts", "layout");

    return { success: true, data: undefined };
  } catch (error) {
    console.error("Failed to delete account:", error);
    return { success: false, error: "Failed to delete account" };
  }
}

/**
 * Update a provider account
 */
export async function updateProviderAccount(
  id: string, 
  data: { name?: string; isActive?: boolean }
): Promise<ActionResult> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Verify ownership
    const [account] = await db.select().from(providerAccount).where(and(eq(providerAccount.id, id), eq(providerAccount.userId, session.user.id))).limit(1);

    if (!account) {
      return { success: false, error: "Account not found" };
    }

    await db.update(providerAccount).set({
      ...(data.name !== undefined && { name: data.name }),
      ...(data.isActive !== undefined && { isActive: data.isActive }),
    }).where(eq(providerAccount.id, id));

    revalidatePath("/dashboard/accounts");
    revalidatePath("/dashboard/accounts", "layout");

    return { success: true, data: undefined };
  } catch (error) {
    console.error("Failed to update account:", error);
    return { success: false, error: "Failed to update account" };
  }
}

/**
 * Get error history for a provider account
 */
export async function getProviderAccountErrorHistory(
  accountId: string,
  limit = 200
): Promise<ActionResult<{ entries: ProviderAccountErrorHistoryEntry[] }>> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  const parsedLimit = Number.isFinite(limit) ? limit : 200;
  const normalizedLimit = Math.max(1, Math.min(200, Math.floor(parsedLimit)));

  try {
    const [account] = await db
      .select({ id: providerAccount.id })
      .from(providerAccount)
      .where(and(eq(providerAccount.id, accountId), eq(providerAccount.userId, session.user.id)))
      .limit(1);

    if (!account) {
      return { success: false, error: "Account not found" };
    }

    const entries = await db
      .select({
        id: providerAccountErrorHistory.id,
        errorCode: providerAccountErrorHistory.errorCode,
        errorMessage: providerAccountErrorHistory.errorMessage,
        createdAt: providerAccountErrorHistory.createdAt,
      })
      .from(providerAccountErrorHistory)
      .where(eq(providerAccountErrorHistory.providerAccountId, accountId))
      .orderBy(
        desc(providerAccountErrorHistory.createdAt),
        desc(providerAccountErrorHistory.id)
      )
      .limit(normalizedLimit);

    return {
      success: true,
      data: {
        entries: entries.map((entry) => {
          const createdAt =
            entry.createdAt instanceof Date
              ? entry.createdAt
              : new Date(entry.createdAt);

          return {
            id: entry.id,
            errorCode: entry.errorCode,
            errorMessage: entry.errorMessage,
            createdAt: Number.isNaN(createdAt.getTime())
              ? new Date(0).toISOString()
              : createdAt.toISOString(),
          };
        }),
      },
    };
  } catch (error) {
    console.error("Failed to get provider account error history:", error);
    return { success: false, error: "Failed to fetch account error history" };
  }
}

/**
 * Resolve (clear) all errors for a provider account.
 * Resets error tracking fields, restores status to "active", and deletes error history.
 */
export async function resolveProviderAccountErrors(
  accountId: string
): Promise<ActionResult> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Verify ownership
    const [account] = await db
      .select({ id: providerAccount.id, status: providerAccount.status })
      .from(providerAccount)
      .where(
        and(
          eq(providerAccount.id, accountId),
          eq(providerAccount.userId, session.user.id)
        )
      )
      .limit(1);

    if (!account) {
      return { success: false, error: "Account not found" };
    }

    // Reset error tracking fields on the account
    const updates: Record<string, unknown> = {
      errorCount: 0,
      consecutiveErrors: 0,
      lastErrorAt: null,
      lastErrorMessage: null,
      lastErrorCode: null,
    };

    // Restore status to active if it was auto-degraded
    if (account.status === "degraded" || account.status === "failed") {
      updates.status = "active";
      updates.statusReason = null;
      updates.statusChangedAt = new Date();
    }

    await db
      .update(providerAccount)
      .set(updates)
      .where(eq(providerAccount.id, accountId));

    // Delete all error history entries for this account
    await db
      .delete(providerAccountErrorHistory)
      .where(eq(providerAccountErrorHistory.providerAccountId, accountId));

    // Delete all per-model health entries for this account
    await db
      .delete(providerAccountModelHealth)
      .where(eq(providerAccountModelHealth.providerAccountId, accountId));

    revalidatePath("/dashboard/accounts");
    revalidatePath("/dashboard/accounts", "layout");

    return { success: true, data: undefined };
  } catch (error) {
    console.error("Failed to resolve provider account errors:", error);
    return { success: false, error: "Failed to resolve account errors" };
  }
}

/**
 * Connect Nvidia account using API key
 */
export async function connectNvidiaNimApiKey(
  apiKey: string,
  accountName?: string
): Promise<ActionResult<{ email: string; isUpdate: boolean }>> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    return await connectApiKeyProviderAccount(
      session.user.id,
      "nvidia_nim",
      "Nvidia",
      apiKey,
      accountName
    );
  } catch (error) {
    console.error("Failed to connect Nvidia account:", error);
    return { success: false, error: "Failed to connect Nvidia account" };
  }
}

/**
 * Connect Ollama Cloud account using API key
 */
export async function connectOllamaCloudApiKey(
  apiKey: string,
  accountName?: string
): Promise<ActionResult<{ email: string; isUpdate: boolean }>> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    return await connectApiKeyProviderAccount(
      session.user.id,
      "ollama_cloud",
      "Ollama Cloud",
      apiKey,
      accountName
    );
  } catch (error) {
    console.error("Failed to connect Ollama Cloud account:", error);
    return { success: false, error: "Failed to connect Ollama Cloud account" };
  }
}

/**
 * Connect OpenRouter account using API key
 */
export async function connectOpenRouterApiKey(
  apiKey: string,
  accountName?: string
): Promise<ActionResult<{ email: string; isUpdate: boolean }>> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    return await connectApiKeyProviderAccount(
      session.user.id,
      "openrouter",
      "OpenRouter",
      apiKey,
      accountName
    );
  } catch (error) {
    console.error("Failed to connect OpenRouter account:", error);
    return { success: false, error: "Failed to connect OpenRouter account" };
  }
}

/**
 * Connect Groq account using API key
 */
export async function connectGroqApiKey(
  apiKey: string,
  accountName?: string
): Promise<ActionResult<{ email: string; isUpdate: boolean }>> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    return await connectApiKeyProviderAccount(
      session.user.id,
      "groq",
      "Groq",
      apiKey,
      accountName
    );
  } catch (error) {
    console.error("Failed to connect Groq account:", error);
    return { success: false, error: "Failed to connect Groq account" };
  }
}

/**
 * Connect Cerebras account using API key
 */
export async function connectCerebrasApiKey(
  apiKey: string,
  accountName?: string
): Promise<ActionResult<{ email: string; isUpdate: boolean }>> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    return await connectApiKeyProviderAccount(
      session.user.id,
      "cerebras",
      "Cerebras",
      apiKey,
      accountName
    );
  } catch (error) {
    console.error("Failed to connect Cerebras account:", error);
    return { success: false, error: "Failed to connect Cerebras account" };
  }
}

/**
 * Connect Kilo Code account using API key
 */
export async function connectKiloCodeApiKey(
  apiKey: string,
  accountName?: string
): Promise<ActionResult<{ email: string; isUpdate: boolean }>> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    return await connectApiKeyProviderAccount(
      session.user.id,
      "kilo_code",
      "Kilo Code",
      apiKey,
      accountName
    );
  } catch (error) {
    console.error("Failed to connect Kilo Code account:", error);
    return { success: false, error: "Failed to connect Kilo Code account" };
  }
}

/**
 * Connect Workers AI account using API token + Cloudflare Account ID
 */
export async function connectWorkersAiApiKey(
  apiToken: string,
  cfAccountId: string,
  accountName?: string
): Promise<ActionResult<{ email: string; isUpdate: boolean }>> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  const normalizedApiToken = apiToken.trim();
  const normalizedAccountId = cfAccountId.trim();

  if (!normalizedApiToken) {
    return { success: false, error: "API token is required" };
  }
  if (!normalizedAccountId) {
    return { success: false, error: "Cloudflare Account ID is required" };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_KEY_VALIDATION_TIMEOUT_MS);

    try {
      const response = await fetch(getWorkersAiValidationUrl(normalizedAccountId), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${normalizedApiToken}`,
          Accept: "application/json",
        },
        signal: controller.signal,
        cache: "no-store",
      });

      if (response.status === 401 || response.status === 403) {
        return { success: false, error: "Workers AI API token is invalid." };
      }

      if (!response.ok) {
        let responseText = "";
        try {
          responseText = await response.text();
        } catch {
          responseText = "";
        }

        const normalizedBody = responseText.toLowerCase();
        const looksLikeAuthFailure =
          normalizedBody.includes("authenticate") ||
          normalizedBody.includes("unauthorized") ||
          normalizedBody.includes("invalid") ||
          normalizedBody.includes("not found");

        if (looksLikeAuthFailure) {
          return { success: false, error: "Workers AI API token or Account ID is invalid." };
        }

        return {
          success: false,
          error: `Unable to validate Workers AI credentials (HTTP ${response.status}). Please try again.`,
        };
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { success: false, error: "Workers AI validation timed out. Please try again." };
      }
      return {
        success: false,
        error: "Unable to validate Workers AI credentials. Please check your network and try again.",
      };
    } finally {
      clearTimeout(timeout);
    }

    const identifier = `workers_ai-${hashString(normalizedApiToken).slice(0, 16)}`;
    const normalizedAccountName = accountName?.trim();

    const [existingAccount] = await db.select().from(providerAccount).where(and(eq(providerAccount.userId, session.user.id), eq(providerAccount.provider, "workers_ai"), eq(providerAccount.email, identifier))).limit(1);

    if (existingAccount) {
      await db.update(providerAccount).set({
        accessToken: encrypt(normalizedApiToken),
        refreshToken: encrypt(normalizedApiToken),
        expiresAt: API_KEY_PROVIDER_ACCOUNT_EXPIRY,
        accountId: normalizedAccountId,
        ...(normalizedAccountName ? { name: normalizedAccountName } : {}),
        isActive: true,
      }).where(eq(providerAccount.id, existingAccount.id));

      revalidatePath("/dashboard", "layout");
      revalidatePath("/dashboard/accounts");
      revalidatePath("/dashboard/playground");

      return {
        success: true,
        data: { email: identifier, isUpdate: true },
      };
    }

    const [countResult] = await db.select({ value: countFn() }).from(providerAccount).where(and(eq(providerAccount.userId, session.user.id), eq(providerAccount.provider, "workers_ai")));
    const accountCount = countResult.value;

    await db.insert(providerAccount).values({
      userId: session.user.id,
      provider: "workers_ai",
      name: normalizedAccountName || `Workers AI ${accountCount + 1}`,
      accessToken: encrypt(normalizedApiToken),
      refreshToken: encrypt(normalizedApiToken),
      expiresAt: API_KEY_PROVIDER_ACCOUNT_EXPIRY,
      email: identifier,
      accountId: normalizedAccountId,
      isActive: true,
    });

    revalidatePath("/dashboard", "layout");
    revalidatePath("/dashboard/accounts");
    revalidatePath("/dashboard/playground");

    return {
      success: true,
      data: { email: identifier, isUpdate: false },
    };
  } catch (error) {
    console.error("Failed to connect Workers AI account:", error);
    return { success: false, error: "Failed to connect Workers AI account" };
  }
}

/**
 * Get all accounts for the current user grouped by provider
 */
export async function getAccountsByProvider(): Promise<
  ActionResult<Record<string, Array<{
    id: string;
    name: string;
    email: string | null;
    isActive: boolean;
    lastUsedAt: Date | null;
    requestCount: number;
    tier: string | null;
  }>>>
> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const accounts = await db.select({
      id: providerAccount.id,
      provider: providerAccount.provider,
      name: providerAccount.name,
      email: providerAccount.email,
      isActive: providerAccount.isActive,
      lastUsedAt: providerAccount.lastUsedAt,
      requestCount: providerAccount.requestCount,
      tier: providerAccount.tier,
    }).from(providerAccount).where(eq(providerAccount.userId, session.user.id)).orderBy(asc(providerAccount.createdAt));

    const grouped: Record<string, typeof accounts> = {};
    for (const account of accounts) {
      if (!grouped[account.provider]) {
        grouped[account.provider] = [];
      }
      grouped[account.provider].push(account);
    }

    return { success: true, data: grouped };
  } catch (error) {
    console.error("Failed to get accounts:", error);
    return { success: false, error: "Failed to get accounts" };
  }
}

/**
 * Get Antigravity (Google) OAuth authorization URL
 */
export async function getAntigravityAuthUrl(): Promise<ActionResult<{ authUrl: string }>> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  const params = new URLSearchParams({
    client_id: ANTIGRAVITY_CLIENT_ID,
    redirect_uri: ANTIGRAVITY_REDIRECT_URI,
    response_type: "code",
    scope: ANTIGRAVITY_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

  return { success: true, data: { authUrl } };
}

/**
 * Exchange Antigravity OAuth callback URL for tokens and create/update account
 */
export async function exchangeAntigravityOAuthCode(
  callbackUrl: string
): Promise<ActionResult<{ email: string; isUpdate: boolean }>> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  if (!callbackUrl || typeof callbackUrl !== "string") {
    return { success: false, error: "Callback URL is required" };
  }

  try {
    // Parse the callback URL to extract the code
    let url: URL;
    try {
      url = new URL(callbackUrl);
    } catch {
      return { success: false, error: "Invalid URL format" };
    }

    const code = url.searchParams.get("code");
    if (!code) {
      return { 
        success: false, 
        error: "No authorization code found in URL. Make sure you copied the complete URL from your browser." 
      };
    }

    // Check for error in URL
    const error = url.searchParams.get("error");
    if (error) {
      return { success: false, error: `Google OAuth error: ${error}` };
    }

    // Exchange code for tokens using the provider
    const oauthResult = await antigravityProvider.exchangeCode(
      code, 
      ANTIGRAVITY_REDIRECT_URI
    );

    // Check if account with this email already exists for this user
    const [existingAccount] = await db.select().from(providerAccount).where(and(eq(providerAccount.userId, session.user.id), eq(providerAccount.provider, "antigravity"), eq(providerAccount.email, oauthResult.email))).limit(1);

    if (existingAccount) {
      // Update existing account
      await db.update(providerAccount).set({
        accessToken: encrypt(oauthResult.accessToken),
        refreshToken: encrypt(oauthResult.refreshToken),
        expiresAt: oauthResult.expiresAt,
        projectId: oauthResult.projectId,
        tier: oauthResult.tier,
        isActive: true,
      }).where(eq(providerAccount.id, existingAccount.id));

      revalidatePath("/dashboard/accounts");

      return {
        success: true,
        data: {
          email: oauthResult.email,
          isUpdate: true,
        },
      };
    } else {
      // Create new account
      const [countResult] = await db.select({ value: countFn() }).from(providerAccount).where(and(eq(providerAccount.userId, session.user.id), eq(providerAccount.provider, "antigravity")));
      const accountCount = countResult.value;

      await db.insert(providerAccount).values({
        userId: session.user.id,
        provider: "antigravity",
        name: `Antigravity ${accountCount + 1}`,
        accessToken: encrypt(oauthResult.accessToken),
        refreshToken: encrypt(oauthResult.refreshToken),
        expiresAt: oauthResult.expiresAt,
        email: oauthResult.email,
        projectId: oauthResult.projectId,
        tier: oauthResult.tier,
        isActive: true,
      });

      revalidatePath("/dashboard/accounts");

      return {
        success: true,
        data: {
          email: oauthResult.email,
          isUpdate: false,
        },
      };
    }
  } catch (err) {
    console.error("Failed to exchange Antigravity OAuth code:", err);
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: errorMessage };
  }
}

/**
 * Initiate Qwen Code Device Code Flow
 * Returns device code info including URL for user to visit
 */
export async function initiateQwenCodeAuth(): Promise<
  ActionResult<{
    deviceCode: string;
    userCode: string;
    verificationUrl: string;
    verificationUrlComplete: string;
    expiresIn: number;
    interval: number;
    codeVerifier: string;
  }>
> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const deviceCodeInfo = await initiateDeviceCodeFlow();

    return {
      success: true,
      data: deviceCodeInfo,
    };
  } catch (err) {
    console.error("Failed to initiate Qwen Code auth:", err);
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: errorMessage };
  }
}

/**
 * Poll Qwen Code device code authorization status
 * Call this periodically until it returns success or error
 */
export async function pollQwenCodeAuth(
  deviceCode: string,
  codeVerifier: string
): Promise<
  ActionResult<
    | { status: "pending" }
    | { status: "success"; email: string; isUpdate: boolean }
    | { status: "error"; message: string }
  >
> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const result = await pollDeviceCodeAuthorization(deviceCode, codeVerifier);

    if ("pending" in result) {
      return { success: true, data: { status: "pending" } };
    }

    if ("error" in result) {
      return { success: true, data: { status: "error", message: result.error } };
    }

    // Success - we have tokens, now save them
    const oauthResult = result;

    // For Qwen Code, email is not automatically provided
    // We'll use a placeholder and user can update later
    const email = oauthResult.email || `qwen-${Date.now()}`;

    // Check if account with this email already exists for this user
    const [existingAccount] = await db.select().from(providerAccount).where(and(eq(providerAccount.userId, session.user.id), eq(providerAccount.provider, "qwen_code"), eq(providerAccount.email, email))).limit(1);

    if (existingAccount) {
      // Update existing account
      await db.update(providerAccount).set({
        accessToken: encrypt(oauthResult.accessToken),
        refreshToken: encrypt(oauthResult.refreshToken),
        expiresAt: oauthResult.expiresAt,
        isActive: true,
      }).where(eq(providerAccount.id, existingAccount.id));

      revalidatePath("/dashboard/accounts");

      return {
        success: true,
        data: {
          status: "success",
          email: email,
          isUpdate: true,
        },
      };
    } else {
      // Create new account
      const [countResult] = await db.select({ value: countFn() }).from(providerAccount).where(and(eq(providerAccount.userId, session.user.id), eq(providerAccount.provider, "qwen_code")));
      const accountCount = countResult.value;

      await db.insert(providerAccount).values({
        userId: session.user.id,
        provider: "qwen_code",
        name: `Qwen Code ${accountCount + 1}`,
        accessToken: encrypt(oauthResult.accessToken),
        refreshToken: encrypt(oauthResult.refreshToken),
        expiresAt: oauthResult.expiresAt,
        email: email,
        isActive: true,
      });

      revalidatePath("/dashboard/accounts");

      return {
        success: true,
        data: {
          status: "success",
          email: email,
          isUpdate: false,
        },
      };
    }
  } catch (err) {
    console.error("Failed to poll Qwen Code auth:", err);
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: errorMessage };
  }
}

/**
 * Complete Qwen Code auth with email identifier
 * Call this after successful auth to set the email/identifier
 */
export async function setQwenCodeAccountEmail(
  accountId: string,
  email: string
): Promise<ActionResult> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Verify ownership
    const [account] = await db.select().from(providerAccount).where(and(eq(providerAccount.id, accountId), eq(providerAccount.userId, session.user.id), eq(providerAccount.provider, "qwen_code"))).limit(1);

    if (!account) {
      return { success: false, error: "Account not found" };
    }

    await db.update(providerAccount).set({
      email: email.trim(),
      name: `Qwen Code (${email.trim()})`,
    }).where(eq(providerAccount.id, accountId));

    revalidatePath("/dashboard/accounts");

    return { success: true, data: undefined };
  } catch (error) {
    console.error("Failed to set Qwen Code account email:", error);
    return { success: false, error: "Failed to update account" };
  }
}

/**
 * Initiate GitHub Copilot Device Code Flow
 */
export async function initiateCopilotAuth(): Promise<
  ActionResult<{
    deviceCode: string;
    userCode: string;
    verificationUrl: string;
    verificationUrlComplete: string;
    expiresIn: number;
    interval: number;
  }>
> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const deviceCodeInfo = await initiateCopilotDeviceCodeFlow();

    return {
      success: true,
      data: deviceCodeInfo,
    };
  } catch (err) {
    console.error("Failed to initiate Copilot auth:", err);
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: errorMessage };
  }
}

/**
 * Poll GitHub Copilot device code authorization status
 */
export async function pollCopilotAuth(
  deviceCode: string
): Promise<
  ActionResult<
    | { status: "pending"; retryAfterSeconds?: number }
    | { status: "success"; email: string; isUpdate: boolean }
    | { status: "error"; message: string }
  >
> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const result = await pollCopilotDeviceCodeAuthorization(deviceCode);

    if ("pending" in result) {
      const retryAfter = "retryAfterSeconds" in result
        ? (result as { retryAfterSeconds?: number }).retryAfterSeconds
        : undefined;
      return {
        success: true,
        data: { status: "pending" as const, retryAfterSeconds: retryAfter },
      };
    }

    if ("error" in result) {
      return { success: true, data: { status: "error", message: result.error } };
    }

    const oauthResult = result;
    const email = oauthResult.email || `copilot-${Date.now()}`;

    const [existingAccount] = await db.select().from(providerAccount).where(and(eq(providerAccount.userId, session.user.id), eq(providerAccount.provider, "copilot"), eq(providerAccount.email, email))).limit(1);

    if (existingAccount) {
      await db.update(providerAccount).set({
        accessToken: encrypt(oauthResult.accessToken),
        refreshToken: encrypt(oauthResult.refreshToken),
        expiresAt: oauthResult.expiresAt,
        isActive: true,
      }).where(eq(providerAccount.id, existingAccount.id));

      revalidatePath("/dashboard/accounts");

      return {
        success: true,
        data: {
          status: "success",
          email,
          isUpdate: true,
        },
      };
    }

    const [countResult] = await db.select({ value: countFn() }).from(providerAccount).where(and(eq(providerAccount.userId, session.user.id), eq(providerAccount.provider, "copilot")));
    const accountCount = countResult.value;

    await db.insert(providerAccount).values({
      userId: session.user.id,
      provider: "copilot",
      name: `Copilot ${accountCount + 1}`,
      accessToken: encrypt(oauthResult.accessToken),
      refreshToken: encrypt(oauthResult.refreshToken),
      expiresAt: oauthResult.expiresAt,
      email,
      isActive: true,
    });

    revalidatePath("/dashboard/accounts");

    return {
      success: true,
      data: {
        status: "success",
        email,
        isUpdate: false,
      },
    };
  } catch (err) {
    console.error("Failed to poll Copilot auth:", err);
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: errorMessage };
  }
}

/**
 * Get Gemini CLI (Google) OAuth authorization URL
 */
export async function getGeminiCliAuthUrl(): Promise<ActionResult<{ authUrl: string }>> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  const params = new URLSearchParams({
    client_id: GEMINI_CLI_CLIENT_ID,
    redirect_uri: GEMINI_CLI_REDIRECT_URI,
    response_type: "code",
    scope: GEMINI_CLI_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

  return { success: true, data: { authUrl } };
}

/**
 * Exchange Gemini CLI OAuth callback URL for tokens and create/update account
 */
export async function exchangeGeminiCliOAuthCode(
  callbackUrl: string
): Promise<ActionResult<{ email: string; isUpdate: boolean }>> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  if (!callbackUrl || typeof callbackUrl !== "string") {
    return { success: false, error: "Callback URL is required" };
  }

  try {
    // Parse the callback URL to extract the code
    let url: URL;
    try {
      url = new URL(callbackUrl);
    } catch {
      return { success: false, error: "Invalid URL format" };
    }

    const code = url.searchParams.get("code");
    if (!code) {
      return { 
        success: false, 
        error: "No authorization code found in URL. Make sure you copied the complete URL from your browser." 
      };
    }

    // Check for error in URL
    const error = url.searchParams.get("error");
    if (error) {
      return { success: false, error: `Google OAuth error: ${error}` };
    }

    // Exchange code for tokens using the provider
    const oauthResult = await geminiCliProvider.exchangeCode(
      code, 
      GEMINI_CLI_REDIRECT_URI
    );

    // Check if account with this email already exists for this user
    const [existingAccount] = await db.select().from(providerAccount).where(and(eq(providerAccount.userId, session.user.id), eq(providerAccount.provider, "gemini_cli"), eq(providerAccount.email, oauthResult.email))).limit(1);

    if (existingAccount) {
      // Update existing account
      await db.update(providerAccount).set({
        accessToken: encrypt(oauthResult.accessToken),
        refreshToken: encrypt(oauthResult.refreshToken),
        expiresAt: oauthResult.expiresAt,
        projectId: oauthResult.projectId,
        tier: oauthResult.tier,
        isActive: true,
      }).where(eq(providerAccount.id, existingAccount.id));

      revalidatePath("/dashboard/accounts");

      return {
        success: true,
        data: {
          email: oauthResult.email,
          isUpdate: true,
        },
      };
    } else {
      // Create new account
      const [countResult] = await db.select({ value: countFn() }).from(providerAccount).where(and(eq(providerAccount.userId, session.user.id), eq(providerAccount.provider, "gemini_cli")));
      const accountCount = countResult.value;

      await db.insert(providerAccount).values({
        userId: session.user.id,
        provider: "gemini_cli",
        name: `Gemini CLI ${accountCount + 1}`,
        accessToken: encrypt(oauthResult.accessToken),
        refreshToken: encrypt(oauthResult.refreshToken),
        expiresAt: oauthResult.expiresAt,
        email: oauthResult.email,
        projectId: oauthResult.projectId,
        tier: oauthResult.tier,
        isActive: true,
      });

      revalidatePath("/dashboard/accounts");

      return {
        success: true,
        data: {
          email: oauthResult.email,
          isUpdate: false,
        },
      };
    }
  } catch (err) {
    console.error("Failed to exchange Gemini CLI OAuth code:", err);
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: errorMessage };
  }
}

/**
 * Get Codex OAuth authorization URL (browser flow)
 */
export async function getCodexAuthUrl(): Promise<ActionResult<{ authUrl: string }>> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const state = generateCodexState();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    const cookieStore = await cookies();
    const context: CodexOAuthContext = { state, codeVerifier };
    cookieStore.set(CODEX_OAUTH_COOKIE_NAME, encrypt(JSON.stringify(context)), {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      maxAge: 10 * 60,
      path: "/",
    });

    const params = new URLSearchParams({
      response_type: "code",
      client_id: CODEX_CLIENT_ID,
      redirect_uri: CODEX_BROWSER_REDIRECT_URI,
      scope: CODEX_OAUTH_SCOPE,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      state,
      originator: CODEX_ORIGINATOR,
    });

    const authUrl = `${CODEX_OAUTH_AUTHORIZE_ENDPOINT}?${params.toString()}`;

    return { success: true, data: { authUrl } };
  } catch (err) {
    console.error("Failed to build Codex auth URL:", err);
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: errorMessage };
  }
}

/**
 * Exchange Codex OAuth callback URL for tokens and create/update account
 */
export async function exchangeCodexOAuthCode(
  callbackUrl: string
): Promise<ActionResult<{ email: string; isUpdate: boolean }>> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  if (!callbackUrl || typeof callbackUrl !== "string") {
    return { success: false, error: "Callback URL is required" };
  }

  try {
    let url: URL;
    try {
      url = new URL(callbackUrl);
    } catch {
      return { success: false, error: "Invalid URL format" };
    }

    const error = url.searchParams.get("error");
    if (error) {
      const message = url.searchParams.get("error_description") || error;
      return { success: false, error: `Codex OAuth error: ${message}` };
    }

    const code = url.searchParams.get("code");
    if (!code) {
      return {
        success: false,
        error: "No authorization code found in URL. Make sure you copied the complete URL from your browser.",
      };
    }

    const callbackState = url.searchParams.get("state");
    if (!callbackState) {
      return { success: false, error: "Missing OAuth state. Please restart authentication." };
    }

    const cookieStore = await cookies();
    const contextCookie = cookieStore.get(CODEX_OAUTH_COOKIE_NAME);
    if (!contextCookie?.value) {
      return { success: false, error: "Session expired. Please restart authentication." };
    }

    let oauthContext: CodexOAuthContext;
    try {
      oauthContext = JSON.parse(decrypt(contextCookie.value)) as CodexOAuthContext;
    } catch {
      cookieStore.delete(CODEX_OAUTH_COOKIE_NAME);
      return { success: false, error: "Invalid authentication state. Please restart authentication." };
    }

    if (!oauthContext.codeVerifier || !oauthContext.state) {
      cookieStore.delete(CODEX_OAUTH_COOKIE_NAME);
      return { success: false, error: "Invalid authentication context. Please restart authentication." };
    }

    if (oauthContext.state !== callbackState) {
      cookieStore.delete(CODEX_OAUTH_COOKIE_NAME);
      return { success: false, error: "Invalid OAuth state. Please restart authentication." };
    }

    const oauthResult = await codexProvider.exchangeCode(
      code,
      CODEX_BROWSER_REDIRECT_URI,
      oauthContext.codeVerifier
    );

    cookieStore.delete(CODEX_OAUTH_COOKIE_NAME);

    const chatgptAccountId = oauthResult.accountId || null;
    const workspaceAccountId = oauthResult.workspaceId || chatgptAccountId || null;
    const workspaceEmail = workspaceAccountId ? `codex-${workspaceAccountId}` : null;
    const detectedTier = await detectCodexTier(
      oauthResult.accessToken,
      chatgptAccountId
    );

    let existingAccount = null;

    if (workspaceEmail) {
      const [found] = await db.select().from(providerAccount).where(and(eq(providerAccount.userId, session.user.id), eq(providerAccount.provider, "codex"), eq(providerAccount.email, workspaceEmail))).limit(1);
      existingAccount = found || null;
    }

    if (!existingAccount && chatgptAccountId && (!workspaceAccountId || workspaceAccountId === chatgptAccountId)) {
      const [found] = await db.select().from(providerAccount).where(and(eq(providerAccount.userId, session.user.id), eq(providerAccount.provider, "codex"), eq(providerAccount.accountId, chatgptAccountId))).limit(1);
      existingAccount = found || null;
    }

    if (existingAccount) {
      await db.update(providerAccount).set({
        accessToken: encrypt(oauthResult.accessToken),
        refreshToken: encrypt(oauthResult.refreshToken),
        expiresAt: oauthResult.expiresAt,
        ...(chatgptAccountId && { accountId: chatgptAccountId }),
        ...(detectedTier && { tier: detectedTier }),
        isActive: true,
      }).where(eq(providerAccount.id, existingAccount.id));

      revalidatePath("/dashboard/accounts");

      return {
        success: true,
        data: {
          email: existingAccount.email || `codex-${chatgptAccountId || "unknown"}`,
          isUpdate: true,
        },
      };
    }

    const [countResult] = await db.select({ value: countFn() }).from(providerAccount).where(and(eq(providerAccount.userId, session.user.id), eq(providerAccount.provider, "codex")));
    const accountCount = countResult.value;

    const email = workspaceEmail || `codex-${Date.now()}`;

    await db.insert(providerAccount).values({
      userId: session.user.id,
      provider: "codex",
      name: `Codex ${accountCount + 1}`,
      accessToken: encrypt(oauthResult.accessToken),
      refreshToken: encrypt(oauthResult.refreshToken),
      expiresAt: oauthResult.expiresAt,
      email,
      accountId: chatgptAccountId,
      tier: detectedTier,
      isActive: true,
    });

    revalidatePath("/dashboard/accounts");

    return {
      success: true,
      data: {
        email,
        isUpdate: false,
      },
    };
  } catch (err) {
    console.error("Failed to exchange Codex OAuth code:", err);
    const cookieStore = await cookies();
    cookieStore.delete(CODEX_OAUTH_COOKIE_NAME);
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: errorMessage };
  }
}

/**
 * Get Kiro OAuth authorization URL (browser flow)
 */
export async function getKiroAuthUrl(): Promise<ActionResult<{ authUrl: string }>> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const state = generateKiroState();
    const codeVerifier = generateKiroCodeVerifier();
    const authUrl = await buildKiroAuthUrl(state, codeVerifier);

    const cookieStore = await cookies();
    const context: KiroOAuthContext = { state, codeVerifier };
    cookieStore.set(KIRO_OAUTH_COOKIE_NAME, encrypt(JSON.stringify(context)), {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      maxAge: 10 * 60,
      path: "/",
    });

    return { success: true, data: { authUrl } };
  } catch (err) {
    console.error("Failed to build Kiro auth URL:", err);
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: errorMessage };
  }
}

/**
 * Exchange Kiro OAuth callback URL for tokens and create/update account
 */
export async function exchangeKiroOAuthCode(
  callbackUrl: string
): Promise<ActionResult<{ email: string; isUpdate: boolean }>> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  if (!callbackUrl || typeof callbackUrl !== "string") {
    return { success: false, error: "Callback URL is required" };
  }

  try {
    let url: URL;
    try {
      url = new URL(callbackUrl);
    } catch {
      return { success: false, error: "Invalid URL format" };
    }

    const error = url.searchParams.get("error");
    if (error) {
      const message = url.searchParams.get("error_description") || error;
      return { success: false, error: `Kiro OAuth error: ${message}` };
    }

    const code = url.searchParams.get("code");
    if (!code) {
      return {
        success: false,
        error:
          "No authorization code found in URL. Make sure you copied the complete URL from your browser.",
      };
    }

    const callbackState = url.searchParams.get("state");
    if (!callbackState) {
      return { success: false, error: "Missing OAuth state. Please restart authentication." };
    }

    const cookieStore = await cookies();
    const contextCookie = cookieStore.get(KIRO_OAUTH_COOKIE_NAME);
    if (!contextCookie?.value) {
      return { success: false, error: "Session expired. Please restart authentication." };
    }

    let oauthContext: KiroOAuthContext;
    try {
      oauthContext = JSON.parse(decrypt(contextCookie.value)) as KiroOAuthContext;
    } catch {
      cookieStore.delete(KIRO_OAUTH_COOKIE_NAME);
      return {
        success: false,
        error: "Invalid authentication state. Please restart authentication.",
      };
    }

    if (!oauthContext.codeVerifier || !oauthContext.state) {
      cookieStore.delete(KIRO_OAUTH_COOKIE_NAME);
      return { success: false, error: "Invalid authentication context. Please restart authentication." };
    }

    if (oauthContext.state !== callbackState) {
      cookieStore.delete(KIRO_OAUTH_COOKIE_NAME);
      return { success: false, error: "Invalid OAuth state. Please restart authentication." };
    }

    const oauthResult = await kiroProvider.exchangeCode(
      code,
      KIRO_BROWSER_REDIRECT_URI,
      oauthContext.codeVerifier
    );

    cookieStore.delete(KIRO_OAUTH_COOKIE_NAME);

    const accountId = oauthResult.accountId || null;
    const email = accountId ? `kiro-${accountId}` : `kiro-${Date.now()}`;

    let existingAccount = null;

    {
      const [found] = await db.select().from(providerAccount).where(and(eq(providerAccount.userId, session.user.id), eq(providerAccount.provider, "kiro"), eq(providerAccount.email, email))).limit(1);
      existingAccount = found || null;
    }

    if (!existingAccount && accountId) {
      const [found] = await db.select().from(providerAccount).where(and(eq(providerAccount.userId, session.user.id), eq(providerAccount.provider, "kiro"), eq(providerAccount.accountId, accountId))).limit(1);
      existingAccount = found || null;
    }

    if (existingAccount) {
      await db.update(providerAccount).set({
        accessToken: encrypt(oauthResult.accessToken),
        refreshToken: encrypt(oauthResult.refreshToken),
        expiresAt: oauthResult.expiresAt,
        ...(accountId ? { accountId } : {}),
        ...(oauthResult.email ? { email: oauthResult.email } : {}),
        isActive: true,
      }).where(eq(providerAccount.id, existingAccount.id));

      revalidatePath("/dashboard/accounts");

      return {
        success: true,
        data: {
          email: existingAccount.email || email,
          isUpdate: true,
        },
      };
    }

    const [countResult] = await db.select({ value: countFn() }).from(providerAccount).where(and(eq(providerAccount.userId, session.user.id), eq(providerAccount.provider, "kiro")));
    const accountCount = countResult.value;

    await db.insert(providerAccount).values({
      userId: session.user.id,
      provider: "kiro",
      name: `Kiro ${accountCount + 1}`,
      accessToken: encrypt(oauthResult.accessToken),
      refreshToken: encrypt(oauthResult.refreshToken),
      expiresAt: oauthResult.expiresAt,
      email,
      accountId,
      isActive: true,
    });

    revalidatePath("/dashboard/accounts");

    return {
      success: true,
      data: {
        email,
        isUpdate: false,
      },
    };
  } catch (err) {
    console.error("Failed to exchange Kiro OAuth code:", err);
    const cookieStore = await cookies();
    cookieStore.delete(KIRO_OAUTH_COOKIE_NAME);
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: errorMessage };
  }
}

/**
 * Initiate Codex Device Code Flow
 * Returns device code info including URL and user code for user to enter
 */
export async function initiateCodexAuth(): Promise<
  ActionResult<{
    deviceAuthId: string;
    userCode: string;
    verificationUrl: string;
    expiresIn: number;
    interval: number;
  }>
> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const deviceCodeInfo = await initiateCodexDeviceCodeFlow();

    // Store PKCE code verifier server-side in an encrypted HttpOnly cookie
    // keyed by deviceAuthId so it never leaves the server
    const cookieStore = await cookies();
    cookieStore.set(`codex_cv_${deviceCodeInfo.deviceAuthId}`, encrypt(deviceCodeInfo.codeVerifier), {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      maxAge: deviceCodeInfo.expiresIn + 60, // device code TTL + buffer
      path: "/",
    });

    // Return everything except codeVerifier
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { codeVerifier: _cv, ...data } = deviceCodeInfo;

    return {
      success: true,
      data,
    };
  } catch (err) {
    console.error("Failed to initiate Codex auth:", err);
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: errorMessage };
  }
}

/**
 * Poll Codex device code authorization status
 * Call this periodically until it returns success or error
 */
export async function pollCodexAuth(
  deviceAuthId: string,
  userCode: string
): Promise<
  ActionResult<
    | { status: "pending" }
    | { status: "success"; email: string; isUpdate: boolean }
    | { status: "error"; message: string }
  >
> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Retrieve PKCE code verifier from server-side cookie
    const cookieStore = await cookies();
    const cvCookie = cookieStore.get(`codex_cv_${deviceAuthId}`);
    if (!cvCookie?.value) {
      return { success: false, error: "Session expired. Please restart authentication." };
    }
    const codeVerifier = decrypt(cvCookie.value);

    const result = await pollCodexDeviceCodeAuthorization(
      deviceAuthId,
      userCode,
      codeVerifier
    );

    if ("pending" in result) {
      return { success: true, data: { status: "pending" } };
    }

    if ("error" in result) {
      const errorMsg = typeof result.error === "string"
        ? result.error
        : (result.error as Record<string, unknown>)?.message as string || JSON.stringify(result.error);
      return { success: true, data: { status: "error", message: errorMsg } };
    }

    // Success - we have tokens, now save them
    const oauthResult = result;
    const chatgptAccountId = oauthResult.accountId || null;
    const workspaceAccountId = oauthResult.workspaceId || chatgptAccountId || null;
    const workspaceEmail = workspaceAccountId ? `codex-${workspaceAccountId}` : null;
    const detectedTier = await detectCodexTier(
      oauthResult.accessToken,
      chatgptAccountId
    );

    // Clean up the PKCE cookie
    cookieStore.delete(`codex_cv_${deviceAuthId}`);

    let existingAccount = null;

    if (workspaceEmail) {
      const [found] = await db.select().from(providerAccount).where(and(eq(providerAccount.userId, session.user.id), eq(providerAccount.provider, "codex"), eq(providerAccount.email, workspaceEmail))).limit(1);
      existingAccount = found || null;
    }

    if (!existingAccount && chatgptAccountId && (!workspaceAccountId || workspaceAccountId === chatgptAccountId)) {
      const [found] = await db.select().from(providerAccount).where(and(eq(providerAccount.userId, session.user.id), eq(providerAccount.provider, "codex"), eq(providerAccount.accountId, chatgptAccountId))).limit(1);
      existingAccount = found || null;
    }

    if (existingAccount) {
      // Update existing account with fresh tokens
      await db.update(providerAccount).set({
        accessToken: encrypt(oauthResult.accessToken),
        refreshToken: encrypt(oauthResult.refreshToken),
        expiresAt: oauthResult.expiresAt,
        ...(chatgptAccountId && { accountId: chatgptAccountId }),
        ...(detectedTier && { tier: detectedTier }),
        isActive: true,
      }).where(eq(providerAccount.id, existingAccount.id));

      revalidatePath("/dashboard/accounts");

      return {
        success: true,
        data: {
          status: "success",
          email: existingAccount.email || `codex-${chatgptAccountId || "unknown"}`,
          isUpdate: true,
        },
      };
    } else {
      // Create new account
      const [countResult] = await db.select({ value: countFn() }).from(providerAccount).where(and(eq(providerAccount.userId, session.user.id), eq(providerAccount.provider, "codex")));
      const accountCount = countResult.value;

      const email = workspaceEmail || `codex-${Date.now()}`;

      await db.insert(providerAccount).values({
        userId: session.user.id,
        provider: "codex",
        name: `Codex ${accountCount + 1}`,
        accessToken: encrypt(oauthResult.accessToken),
        refreshToken: encrypt(oauthResult.refreshToken),
        expiresAt: oauthResult.expiresAt,
        email,
        accountId: chatgptAccountId,
        tier: detectedTier,
        isActive: true,
      });

      revalidatePath("/dashboard/accounts");

      return {
        success: true,
        data: {
          status: "success",
          email,
          isUpdate: false,
        },
      };
    }
  } catch (err) {
    console.error("Failed to poll Codex auth:", err);
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: errorMessage };
  }
}

/**
 * Set the email/identifier for a Codex account
 * Call this after successful auth to set a recognizable name
 */
export async function setCodexAccountEmail(
  accountId: string,
  email: string
): Promise<ActionResult> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Verify ownership
    const [account] = await db.select().from(providerAccount).where(and(eq(providerAccount.id, accountId), eq(providerAccount.userId, session.user.id), eq(providerAccount.provider, "codex"))).limit(1);

    if (!account) {
      return { success: false, error: "Account not found" };
    }

    await db.update(providerAccount).set({
      email: email.trim(),
      name: `Codex (${email.trim()})`,
    }).where(eq(providerAccount.id, accountId));

    revalidatePath("/dashboard/accounts");

    return { success: true, data: undefined };
  } catch (error) {
    console.error("Failed to set Codex account email:", error);
    return { success: false, error: "Failed to update account" };
  }
}
