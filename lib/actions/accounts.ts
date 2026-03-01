"use server";

import { Effect } from "effect";
import { DatabaseService, SessionService, requireUserId } from "@/lib/effect/services";
import { DatabaseError, NotFoundError, UnauthorizedError, ValidationError } from "@/lib/effect/errors";
import { runServerAction, MainLayer } from "@/lib/effect/runtime";
import type { ActionResult } from "@/lib/effect/runtime";
import { providerAccount, providerAccountErrorHistory } from "@/lib/db/schema";
import { eq, and, count as countFn, asc, desc } from "drizzle-orm";
import { encrypt, decrypt, hashString } from "@/lib/encryption";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { iflowProvider } from "@/lib/proxy/providers/iflow";
import {
  IFLOW_REDIRECT_URI,
  IFLOW_OAUTH_AUTHORIZE_URL,
  IFLOW_CLIENT_ID,
} from "@/lib/proxy/providers/iflow/constants";
import { antigravityProvider } from "@/lib/proxy/providers/antigravity";
import {
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_SCOPES,
} from "@/lib/proxy/providers/antigravity/constants";
import { geminiCliProvider } from "@/lib/proxy/providers/gemini-cli";
import {
  GEMINI_CLI_REDIRECT_URI,
  GEMINI_CLI_CLIENT_ID,
  GEMINI_CLI_SCOPES,
} from "@/lib/proxy/providers/gemini-cli/constants";
import {
  initiateDeviceCodeFlow,
  pollDeviceCodeAuthorization,
} from "@/lib/proxy/providers/qwen-code";
import {
  initiateCopilotDeviceCodeFlow,
  pollCopilotDeviceCodeAuthorization,
} from "@/lib/proxy/providers/copilot";
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
} from "@/lib/proxy/providers/codex";
import {
  buildKiroAuthUrl,
  generateCodeVerifier as generateKiroCodeVerifier,
  kiroProvider,
  KIRO_BROWSER_REDIRECT_URI,
} from "@/lib/proxy/providers/kiro";
import {
  NVIDIA_NIM_API_BASE_URL,
  NVIDIA_NIM_MODEL_MAP,
} from "@/lib/proxy/providers/nvidia-nim/constants";
import {
  OLLAMA_CLOUD_API_BASE_URL,
  OLLAMA_CLOUD_MODEL_MAP,
} from "@/lib/proxy/providers/ollama-cloud/constants";
import {
  OPENROUTER_API_BASE_URL,
  OPENROUTER_MODEL_MAP,
} from "@/lib/proxy/providers/openrouter/constants";

export type { ActionResult };

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
    modelMap: NVIDIA_NIM_MODEL_MAP,
    validationPath: "/chat/completions",
    requireSuccessfulStatus: false,
  },
  ollama_cloud: {
    label: "Ollama Cloud",
    baseUrl: OLLAMA_CLOUD_API_BASE_URL,
    modelMap: OLLAMA_CLOUD_MODEL_MAP,
    validationPath: "/chat/completions",
    requireSuccessfulStatus: false,
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: OPENROUTER_API_BASE_URL,
    modelMap: OPENROUTER_MODEL_MAP,
    validationPath: "/models",
    requireSuccessfulStatus: true,
  },
} as const;

type ApiKeyProvider = keyof typeof API_KEY_PROVIDER_SETTINGS;

// ---------------------------------------------------------------------------
// Helper Effects
// ---------------------------------------------------------------------------

/**
 * Revalidate all dashboard account-related paths.
 */
const revalidateAccountPaths = Effect.sync(() => {
  revalidatePath("/dashboard", "layout");
  revalidatePath("/dashboard/accounts");
  revalidatePath("/dashboard/playground");
});

/**
 * Validate a provider API key by making a test request.
 */
const validateProviderApiKeyEffect = (
  provider: ApiKeyProvider,
  apiKey: string
): Effect.Effect<void, ValidationError, never> =>
  Effect.gen(function* () {
    const {
      label,
      baseUrl,
      modelMap,
      validationPath = "/chat/completions",
      requireSuccessfulStatus = false,
    } = API_KEY_PROVIDER_SETTINGS[provider];
    const validationModel = Object.values(modelMap)[0];

    if (validationPath === "/chat/completions" && !validationModel) {
      return yield* new ValidationError({
        message: `${label} API key validation model is not configured.`,
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_KEY_VALIDATION_TIMEOUT_MS);

    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(`${baseUrl}${validationPath}`, {
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
        }),
      catch: (error) => {
        clearTimeout(timeout);
        if (error instanceof Error && error.name === "AbortError") {
          return new ValidationError({
            message: `${label} API key validation timed out. Please try again.`,
          });
        }
        return new ValidationError({
          message: `Unable to validate ${label} API key. Please check your network and try again.`,
        });
      },
    }).pipe(Effect.tap(() => Effect.sync(() => clearTimeout(timeout))));

    if (response.status === 401 || response.status === 403) {
      return yield* new ValidationError({
        message: `${label} API key is invalid.`,
      });
    }

    if (requireSuccessfulStatus && !response.ok) {
      const responseText = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: () => "",
      }).pipe(Effect.catchAll(() => Effect.succeed("")));

      const normalizedBody = responseText.toLowerCase();
      const looksLikeAuthFailure =
        normalizedBody.includes("authenticate") ||
        normalizedBody.includes("unauthorized") ||
        normalizedBody.includes("invalid api key") ||
        normalizedBody.includes("user not found");

      if (looksLikeAuthFailure) {
        return yield* new ValidationError({
          message: `${label} API key is invalid.`,
        });
      }

      return yield* new ValidationError({
        message: `Unable to validate ${label} API key right now (HTTP ${response.status}). Please try again.`,
      });
    }
  });

/**
 * Connect/update a provider account using an API key.
 */
const connectApiKeyProviderAccountEffect = (
  userId: string,
  provider: ApiKeyProvider,
  providerLabel: string,
  apiKey: string,
  accountName?: string
): Effect.Effect<{ email: string; isUpdate: boolean }, ValidationError | DatabaseError, DatabaseService> =>
  Effect.gen(function* () {
    const normalizedApiKey = apiKey.trim();
    if (!normalizedApiKey) {
      return yield* new ValidationError({ message: "API key is required" });
    }

    yield* validateProviderApiKeyEffect(provider, normalizedApiKey);

    const db = yield* DatabaseService;
    const identifier = `${provider}-${hashString(normalizedApiKey).slice(0, 16)}`;
    const normalizedAccountName = accountName?.trim();

    const existingAccounts = yield* Effect.tryPromise({
      try: () =>
        db
          .select()
          .from(providerAccount)
          .where(
            and(
              eq(providerAccount.userId, userId),
              eq(providerAccount.provider, provider),
              eq(providerAccount.email, identifier)
            )
          )
          .limit(1),
      catch: (cause) => new DatabaseError({ cause }),
    });

    const existingAccount = existingAccounts[0];

    if (existingAccount) {
      yield* Effect.tryPromise({
        try: () =>
          db
            .update(providerAccount)
            .set({
              accessToken: encrypt(normalizedApiKey),
              refreshToken: encrypt(normalizedApiKey),
              expiresAt: API_KEY_PROVIDER_ACCOUNT_EXPIRY,
              ...(normalizedAccountName ? { name: normalizedAccountName } : {}),
              isActive: true,
            })
            .where(eq(providerAccount.id, existingAccount.id)),
        catch: (cause) => new DatabaseError({ cause }),
      });

      yield* revalidateAccountPaths;

      return { email: identifier, isUpdate: true };
    }

    const countResults = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ value: countFn() })
          .from(providerAccount)
          .where(
            and(
              eq(providerAccount.userId, userId),
              eq(providerAccount.provider, provider)
            )
          ),
      catch: (cause) => new DatabaseError({ cause }),
    });
    const accountCount = countResults[0].value;

    yield* Effect.tryPromise({
      try: () =>
        db.insert(providerAccount).values({
          userId,
          provider,
          name: normalizedAccountName || `${providerLabel} ${accountCount + 1}`,
          accessToken: encrypt(normalizedApiKey),
          refreshToken: encrypt(normalizedApiKey),
          expiresAt: API_KEY_PROVIDER_ACCOUNT_EXPIRY,
          email: identifier,
          isActive: true,
        }),
      catch: (cause) => new DatabaseError({ cause }),
    });

    yield* revalidateAccountPaths;

    return { email: identifier, isUpdate: false };
  });

/**
 * Upsert an OAuth-based provider account.
 */
const upsertOAuthAccountEffect = (
  userId: string,
  provider: string,
  providerLabel: string,
  oauthResult: {
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
    email: string;
    apiKey?: string | null;
    projectId?: string | null;
    tier?: string | null;
    accountId?: string | null;
  }
): Effect.Effect<{ email: string; isUpdate: boolean }, DatabaseError, DatabaseService> =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    const existingAccounts = yield* Effect.tryPromise({
      try: () =>
        db
          .select()
          .from(providerAccount)
          .where(
            and(
              eq(providerAccount.userId, userId),
              eq(providerAccount.provider, provider),
              eq(providerAccount.email, oauthResult.email)
            )
          )
          .limit(1),
      catch: (cause) => new DatabaseError({ cause }),
    });

    const existingAccount = existingAccounts[0];

    if (existingAccount) {
      yield* Effect.tryPromise({
        try: () =>
          db
            .update(providerAccount)
            .set({
              accessToken: encrypt(oauthResult.accessToken),
              refreshToken: encrypt(oauthResult.refreshToken),
              ...(oauthResult.apiKey !== undefined && {
                apiKey: oauthResult.apiKey ? encrypt(oauthResult.apiKey) : null,
              }),
              expiresAt: oauthResult.expiresAt,
              ...(oauthResult.projectId !== undefined && { projectId: oauthResult.projectId }),
              ...(oauthResult.tier !== undefined && { tier: oauthResult.tier }),
              isActive: true,
            })
            .where(eq(providerAccount.id, existingAccount.id)),
        catch: (cause) => new DatabaseError({ cause }),
      });

      yield* Effect.sync(() => revalidatePath("/dashboard/accounts"));

      return { email: oauthResult.email, isUpdate: true };
    }

    const countResults = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ value: countFn() })
          .from(providerAccount)
          .where(
            and(
              eq(providerAccount.userId, userId),
              eq(providerAccount.provider, provider)
            )
          ),
      catch: (cause) => new DatabaseError({ cause }),
    });
    const accountCount = countResults[0].value;

    yield* Effect.tryPromise({
      try: () =>
        db.insert(providerAccount).values({
          userId,
          provider,
          name: `${providerLabel} ${accountCount + 1}`,
          accessToken: encrypt(oauthResult.accessToken),
          refreshToken: encrypt(oauthResult.refreshToken),
          ...(oauthResult.apiKey !== undefined && {
            apiKey: oauthResult.apiKey ? encrypt(oauthResult.apiKey) : null,
          }),
          expiresAt: oauthResult.expiresAt,
          email: oauthResult.email,
          ...(oauthResult.projectId !== undefined && { projectId: oauthResult.projectId }),
          ...(oauthResult.tier !== undefined && { tier: oauthResult.tier }),
          isActive: true,
        }),
      catch: (cause) => new DatabaseError({ cause }),
    });

    yield* Effect.sync(() => revalidatePath("/dashboard/accounts"));

    return { email: oauthResult.email, isUpdate: false };
  });

/**
 * Parse an OAuth callback URL and extract the authorization code.
 */
const extractOAuthCodeEffect = (
  callbackUrl: string,
  providerLabel: string
): Effect.Effect<string, ValidationError, never> =>
  Effect.gen(function* () {
    if (!callbackUrl || typeof callbackUrl !== "string") {
      return yield* new ValidationError({ message: "Callback URL is required" });
    }

    let url: URL;
    try {
      url = new URL(callbackUrl);
    } catch {
      return yield* new ValidationError({ message: "Invalid URL format" });
    }

    const error = url.searchParams.get("error");
    if (error) {
      return yield* new ValidationError({
        message: `${providerLabel} OAuth error: ${error}`,
      });
    }

    const code = url.searchParams.get("code");
    if (!code) {
      return yield* new ValidationError({
        message: "No authorization code found in URL. Make sure you copied the complete URL from your browser.",
      });
    }

    return code;
  });

// ---------------------------------------------------------------------------
// Public API — server actions with unchanged signatures
// ---------------------------------------------------------------------------

/**
 * Delete a provider account
 */
export async function deleteProviderAccount(id: string): Promise<ActionResult> {
  return runServerAction(
    Effect.gen(function* () {
      const userId = yield* requireUserId;
      const db = yield* DatabaseService;

      const accounts = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(providerAccount)
            .where(and(eq(providerAccount.id, id), eq(providerAccount.userId, userId)))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (!accounts[0]) {
        return yield* new NotFoundError({ message: "Account not found" });
      }

      yield* Effect.tryPromise({
        try: () => db.delete(providerAccount).where(eq(providerAccount.id, id)),
        catch: (cause) => new DatabaseError({ cause }),
      });

      yield* Effect.sync(() => {
        revalidatePath("/dashboard/accounts");
        revalidatePath("/dashboard/accounts", "layout");
      });
    }),
    MainLayer
  );
}

/**
 * Update a provider account
 */
export async function updateProviderAccount(
  id: string,
  data: { name?: string; isActive?: boolean }
): Promise<ActionResult> {
  return runServerAction(
    Effect.gen(function* () {
      const userId = yield* requireUserId;
      const db = yield* DatabaseService;

      const accounts = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(providerAccount)
            .where(and(eq(providerAccount.id, id), eq(providerAccount.userId, userId)))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (!accounts[0]) {
        return yield* new NotFoundError({ message: "Account not found" });
      }

      yield* Effect.tryPromise({
        try: () =>
          db
            .update(providerAccount)
            .set({
              ...(data.name !== undefined && { name: data.name }),
              ...(data.isActive !== undefined && { isActive: data.isActive }),
            })
            .where(eq(providerAccount.id, id)),
        catch: (cause) => new DatabaseError({ cause }),
      });

      yield* Effect.sync(() => {
        revalidatePath("/dashboard/accounts");
        revalidatePath("/dashboard/accounts", "layout");
      });
    }),
    MainLayer
  );
}

/**
 * Get error history for a provider account
 */
export async function getProviderAccountErrorHistory(
  accountId: string,
  limit = 200
): Promise<ActionResult<{ entries: ProviderAccountErrorHistoryEntry[] }>> {
  return runServerAction(
    Effect.gen(function* () {
      const userId = yield* requireUserId;
      const db = yield* DatabaseService;

      const parsedLimit = Number.isFinite(limit) ? limit : 200;
      const normalizedLimit = Math.max(1, Math.min(200, Math.floor(parsedLimit)));

      const accounts = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ id: providerAccount.id })
            .from(providerAccount)
            .where(
              and(eq(providerAccount.id, accountId), eq(providerAccount.userId, userId))
            )
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (!accounts[0]) {
        return yield* new NotFoundError({ message: "Account not found" });
      }

      const entries = yield* Effect.tryPromise({
        try: () =>
          db
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
            .limit(normalizedLimit),
        catch: (cause) => new DatabaseError({ cause }),
      });

      return {
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
      };
    }),
    MainLayer
  );
}

/**
 * Connect Nvidia account using API key
 */
export async function connectNvidiaNimApiKey(
  apiKey: string,
  accountName?: string
): Promise<ActionResult<{ email: string; isUpdate: boolean }>> {
  return runServerAction(
    Effect.gen(function* () {
      const userId = yield* requireUserId;
      return yield* connectApiKeyProviderAccountEffect(
        userId,
        "nvidia_nim",
        "Nvidia",
        apiKey,
        accountName
      );
    }),
    MainLayer
  );
}

/**
 * Connect Ollama Cloud account using API key
 */
export async function connectOllamaCloudApiKey(
  apiKey: string,
  accountName?: string
): Promise<ActionResult<{ email: string; isUpdate: boolean }>> {
  return runServerAction(
    Effect.gen(function* () {
      const userId = yield* requireUserId;
      return yield* connectApiKeyProviderAccountEffect(
        userId,
        "ollama_cloud",
        "Ollama Cloud",
        apiKey,
        accountName
      );
    }),
    MainLayer
  );
}

/**
 * Connect OpenRouter account using API key
 */
export async function connectOpenRouterApiKey(
  apiKey: string,
  accountName?: string
): Promise<ActionResult<{ email: string; isUpdate: boolean }>> {
  return runServerAction(
    Effect.gen(function* () {
      const userId = yield* requireUserId;
      return yield* connectApiKeyProviderAccountEffect(
        userId,
        "openrouter",
        "OpenRouter",
        apiKey,
        accountName
      );
    }),
    MainLayer
  );
}

/**
 * Exchange Iflow OAuth callback URL for tokens and create/update account
 */
export async function exchangeIflowOAuthCode(
  callbackUrl: string
): Promise<ActionResult<{ email: string; isUpdate: boolean }>> {
  return runServerAction(
    Effect.gen(function* () {
      const userId = yield* requireUserId;
      const code = yield* extractOAuthCodeEffect(callbackUrl, "Iflow");

      const oauthResult = yield* Effect.tryPromise({
        try: () => iflowProvider.exchangeCode(code, IFLOW_REDIRECT_URI),
        catch: (cause) => new DatabaseError({ cause }),
      });

      return yield* upsertOAuthAccountEffect(userId, "iflow", "Iflow", {
        accessToken: oauthResult.accessToken,
        refreshToken: oauthResult.refreshToken,
        expiresAt: oauthResult.expiresAt,
        email: oauthResult.email,
        apiKey: oauthResult.apiKey,
      });
    }),
    MainLayer
  );
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
  return runServerAction(
    Effect.gen(function* () {
      const userId = yield* requireUserId;
      const db = yield* DatabaseService;

      const accounts = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              id: providerAccount.id,
              provider: providerAccount.provider,
              name: providerAccount.name,
              email: providerAccount.email,
              isActive: providerAccount.isActive,
              lastUsedAt: providerAccount.lastUsedAt,
              requestCount: providerAccount.requestCount,
              tier: providerAccount.tier,
            })
            .from(providerAccount)
            .where(eq(providerAccount.userId, userId))
            .orderBy(asc(providerAccount.createdAt)),
        catch: (cause) => new DatabaseError({ cause }),
      });

      const grouped: Record<string, typeof accounts> = {};
      for (const account of accounts) {
        if (!grouped[account.provider]) {
          grouped[account.provider] = [];
        }
        grouped[account.provider].push(account);
      }

      return grouped;
    }),
    MainLayer
  );
}

// Backwards compatibility aliases
export const deleteIflowAccount = deleteProviderAccount;
export const updateIflowAccount = updateProviderAccount;

/**
 * Get Iflow OAuth authorization URL
 */
export async function getIflowAuthUrl(): Promise<ActionResult<{ authUrl: string }>> {
  return runServerAction(
    Effect.gen(function* () {
      yield* requireUserId;

      const authParams = new URLSearchParams({
        loginMethod: "phone",
        type: "phone",
        redirect: IFLOW_REDIRECT_URI,
        client_id: IFLOW_CLIENT_ID,
      });

      return { authUrl: `${IFLOW_OAUTH_AUTHORIZE_URL}?${authParams.toString()}` };
    }),
    MainLayer
  );
}

/**
 * Get Antigravity (Google) OAuth authorization URL
 */
export async function getAntigravityAuthUrl(): Promise<ActionResult<{ authUrl: string }>> {
  return runServerAction(
    Effect.gen(function* () {
      yield* requireUserId;

      const params = new URLSearchParams({
        client_id: ANTIGRAVITY_CLIENT_ID,
        redirect_uri: ANTIGRAVITY_REDIRECT_URI,
        response_type: "code",
        scope: ANTIGRAVITY_SCOPES.join(" "),
        access_type: "offline",
        prompt: "consent",
      });

      return { authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params}` };
    }),
    MainLayer
  );
}

/**
 * Exchange Antigravity OAuth callback URL for tokens and create/update account
 */
export async function exchangeAntigravityOAuthCode(
  callbackUrl: string
): Promise<ActionResult<{ email: string; isUpdate: boolean }>> {
  return runServerAction(
    Effect.gen(function* () {
      const userId = yield* requireUserId;
      const code = yield* extractOAuthCodeEffect(callbackUrl, "Google");

      const oauthResult = yield* Effect.tryPromise({
        try: () => antigravityProvider.exchangeCode(code, ANTIGRAVITY_REDIRECT_URI),
        catch: (cause) => new DatabaseError({ cause }),
      });

      return yield* upsertOAuthAccountEffect(userId, "antigravity", "Antigravity", {
        accessToken: oauthResult.accessToken,
        refreshToken: oauthResult.refreshToken,
        expiresAt: oauthResult.expiresAt,
        email: oauthResult.email,
        projectId: oauthResult.projectId,
        tier: oauthResult.tier,
      });
    }),
    MainLayer
  );
}

/**
 * Initiate Qwen Code Device Code Flow
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
  return runServerAction(
    Effect.gen(function* () {
      yield* requireUserId;

      return yield* Effect.tryPromise({
        try: () => initiateDeviceCodeFlow(),
        catch: (cause) => new DatabaseError({ cause }),
      });
    }),
    MainLayer
  );
}

/**
 * Poll Qwen Code device code authorization status
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
  return runServerAction(
    Effect.gen(function* () {
      const userId = yield* requireUserId;
      const db = yield* DatabaseService;

      const result = yield* Effect.tryPromise({
        try: () => pollDeviceCodeAuthorization(deviceCode, codeVerifier),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if ("pending" in result) {
        return { status: "pending" as const };
      }

      if ("error" in result) {
        return { status: "error" as const, message: result.error };
      }

      const oauthResult = result;
      const email = oauthResult.email || `qwen-${Date.now()}`;

      const existingAccounts = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(providerAccount)
            .where(
              and(
                eq(providerAccount.userId, userId),
                eq(providerAccount.provider, "qwen_code"),
                eq(providerAccount.email, email)
              )
            )
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (existingAccounts[0]) {
        yield* Effect.tryPromise({
          try: () =>
            db
              .update(providerAccount)
              .set({
                accessToken: encrypt(oauthResult.accessToken),
                refreshToken: encrypt(oauthResult.refreshToken),
                expiresAt: oauthResult.expiresAt,
                isActive: true,
              })
              .where(eq(providerAccount.id, existingAccounts[0].id)),
          catch: (cause) => new DatabaseError({ cause }),
        });

        yield* Effect.sync(() => revalidatePath("/dashboard/accounts"));

        return { status: "success" as const, email, isUpdate: true };
      }

      const countResults = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ value: countFn() })
            .from(providerAccount)
            .where(
              and(
                eq(providerAccount.userId, userId),
                eq(providerAccount.provider, "qwen_code")
              )
            ),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const accountCount = countResults[0].value;

      yield* Effect.tryPromise({
        try: () =>
          db.insert(providerAccount).values({
            userId,
            provider: "qwen_code",
            name: `Qwen Code ${accountCount + 1}`,
            accessToken: encrypt(oauthResult.accessToken),
            refreshToken: encrypt(oauthResult.refreshToken),
            expiresAt: oauthResult.expiresAt,
            email,
            isActive: true,
          }),
        catch: (cause) => new DatabaseError({ cause }),
      });

      yield* Effect.sync(() => revalidatePath("/dashboard/accounts"));

      return { status: "success" as const, email, isUpdate: false };
    }),
    MainLayer
  );
}

/**
 * Complete Qwen Code auth with email identifier
 */
export async function setQwenCodeAccountEmail(
  accountId: string,
  email: string
): Promise<ActionResult> {
  return runServerAction(
    Effect.gen(function* () {
      const userId = yield* requireUserId;
      const db = yield* DatabaseService;

      const accounts = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(providerAccount)
            .where(
              and(
                eq(providerAccount.id, accountId),
                eq(providerAccount.userId, userId),
                eq(providerAccount.provider, "qwen_code")
              )
            )
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (!accounts[0]) {
        return yield* new NotFoundError({ message: "Account not found" });
      }

      yield* Effect.tryPromise({
        try: () =>
          db
            .update(providerAccount)
            .set({
              email: email.trim(),
              name: `Qwen Code (${email.trim()})`,
            })
            .where(eq(providerAccount.id, accountId)),
        catch: (cause) => new DatabaseError({ cause }),
      });

      yield* Effect.sync(() => revalidatePath("/dashboard/accounts"));
    }),
    MainLayer
  );
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
  return runServerAction(
    Effect.gen(function* () {
      yield* requireUserId;

      return yield* Effect.tryPromise({
        try: () => initiateCopilotDeviceCodeFlow(),
        catch: (cause) => new DatabaseError({ cause }),
      });
    }),
    MainLayer
  );
}

/**
 * Poll GitHub Copilot device code authorization status
 */
export async function pollCopilotAuth(
  deviceCode: string
): Promise<
  ActionResult<
    | { status: "pending" }
    | { status: "success"; email: string; isUpdate: boolean }
    | { status: "error"; message: string }
  >
> {
  return runServerAction(
    Effect.gen(function* () {
      const userId = yield* requireUserId;
      const db = yield* DatabaseService;

      const result = yield* Effect.tryPromise({
        try: () => pollCopilotDeviceCodeAuthorization(deviceCode),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if ("pending" in result) {
        return { status: "pending" as const };
      }

      if ("error" in result) {
        return { status: "error" as const, message: result.error };
      }

      const oauthResult = result;
      const email = oauthResult.email || `copilot-${Date.now()}`;

      const existingAccounts = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(providerAccount)
            .where(
              and(
                eq(providerAccount.userId, userId),
                eq(providerAccount.provider, "copilot"),
                eq(providerAccount.email, email)
              )
            )
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (existingAccounts[0]) {
        yield* Effect.tryPromise({
          try: () =>
            db
              .update(providerAccount)
              .set({
                accessToken: encrypt(oauthResult.accessToken),
                refreshToken: encrypt(oauthResult.refreshToken),
                expiresAt: oauthResult.expiresAt,
                isActive: true,
              })
              .where(eq(providerAccount.id, existingAccounts[0].id)),
          catch: (cause) => new DatabaseError({ cause }),
        });

        yield* Effect.sync(() => revalidatePath("/dashboard/accounts"));

        return { status: "success" as const, email, isUpdate: true };
      }

      const countResults = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ value: countFn() })
            .from(providerAccount)
            .where(
              and(
                eq(providerAccount.userId, userId),
                eq(providerAccount.provider, "copilot")
              )
            ),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const accountCount = countResults[0].value;

      yield* Effect.tryPromise({
        try: () =>
          db.insert(providerAccount).values({
            userId,
            provider: "copilot",
            name: `Copilot ${accountCount + 1}`,
            accessToken: encrypt(oauthResult.accessToken),
            refreshToken: encrypt(oauthResult.refreshToken),
            expiresAt: oauthResult.expiresAt,
            email,
            isActive: true,
          }),
        catch: (cause) => new DatabaseError({ cause }),
      });

      yield* Effect.sync(() => revalidatePath("/dashboard/accounts"));

      return { status: "success" as const, email, isUpdate: false };
    }),
    MainLayer
  );
}

/**
 * Get Gemini CLI (Google) OAuth authorization URL
 */
export async function getGeminiCliAuthUrl(): Promise<ActionResult<{ authUrl: string }>> {
  return runServerAction(
    Effect.gen(function* () {
      yield* requireUserId;

      const params = new URLSearchParams({
        client_id: GEMINI_CLI_CLIENT_ID,
        redirect_uri: GEMINI_CLI_REDIRECT_URI,
        response_type: "code",
        scope: GEMINI_CLI_SCOPES.join(" "),
        access_type: "offline",
        prompt: "consent",
      });

      return { authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params}` };
    }),
    MainLayer
  );
}

/**
 * Exchange Gemini CLI OAuth callback URL for tokens and create/update account
 */
export async function exchangeGeminiCliOAuthCode(
  callbackUrl: string
): Promise<ActionResult<{ email: string; isUpdate: boolean }>> {
  return runServerAction(
    Effect.gen(function* () {
      const userId = yield* requireUserId;
      const code = yield* extractOAuthCodeEffect(callbackUrl, "Google");

      const oauthResult = yield* Effect.tryPromise({
        try: () => geminiCliProvider.exchangeCode(code, GEMINI_CLI_REDIRECT_URI),
        catch: (cause) => new DatabaseError({ cause }),
      });

      return yield* upsertOAuthAccountEffect(userId, "gemini_cli", "Gemini CLI", {
        accessToken: oauthResult.accessToken,
        refreshToken: oauthResult.refreshToken,
        expiresAt: oauthResult.expiresAt,
        email: oauthResult.email,
        projectId: oauthResult.projectId,
        tier: oauthResult.tier,
      });
    }),
    MainLayer
  );
}

/**
 * Get Codex OAuth authorization URL (browser flow)
 */
export async function getCodexAuthUrl(): Promise<ActionResult<{ authUrl: string }>> {
  return runServerAction(
    Effect.gen(function* () {
      yield* requireUserId;

      const state = generateCodexState();
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = yield* Effect.tryPromise({
        try: () => generateCodeChallenge(codeVerifier),
        catch: (cause) => new DatabaseError({ cause }),
      });

      const cookieStore = yield* Effect.tryPromise({
        try: () => cookies(),
        catch: (cause) => new DatabaseError({ cause }),
      });

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

      return { authUrl: `${CODEX_OAUTH_AUTHORIZE_ENDPOINT}?${params.toString()}` };
    }),
    MainLayer
  );
}

/**
 * Exchange Codex OAuth callback URL for tokens and create/update account
 */
export async function exchangeCodexOAuthCode(
  callbackUrl: string
): Promise<ActionResult<{ email: string; isUpdate: boolean }>> {
  return runServerAction(
    Effect.gen(function* () {
      const userId = yield* requireUserId;
      const db = yield* DatabaseService;

      // Parse URL
      if (!callbackUrl || typeof callbackUrl !== "string") {
        return yield* new ValidationError({ message: "Callback URL is required" });
      }

      let url: URL;
      try {
        url = new URL(callbackUrl);
      } catch {
        return yield* new ValidationError({ message: "Invalid URL format" });
      }

      const error = url.searchParams.get("error");
      if (error) {
        const message = url.searchParams.get("error_description") || error;
        return yield* new ValidationError({ message: `Codex OAuth error: ${message}` });
      }

      const code = url.searchParams.get("code");
      if (!code) {
        return yield* new ValidationError({
          message: "No authorization code found in URL. Make sure you copied the complete URL from your browser.",
        });
      }

      const callbackState = url.searchParams.get("state");
      if (!callbackState) {
        return yield* new ValidationError({
          message: "Missing OAuth state. Please restart authentication.",
        });
      }

      // Validate state from cookie
      const cookieStore = yield* Effect.tryPromise({
        try: () => cookies(),
        catch: (cause) => new DatabaseError({ cause }),
      });

      const contextCookie = cookieStore.get(CODEX_OAUTH_COOKIE_NAME);
      if (!contextCookie?.value) {
        return yield* new ValidationError({
          message: "Session expired. Please restart authentication.",
        });
      }

      let oauthContext: CodexOAuthContext;
      try {
        oauthContext = JSON.parse(decrypt(contextCookie.value)) as CodexOAuthContext;
      } catch {
        cookieStore.delete(CODEX_OAUTH_COOKIE_NAME);
        return yield* new ValidationError({
          message: "Invalid authentication state. Please restart authentication.",
        });
      }

      if (!oauthContext.codeVerifier || !oauthContext.state) {
        cookieStore.delete(CODEX_OAUTH_COOKIE_NAME);
        return yield* new ValidationError({
          message: "Invalid authentication context. Please restart authentication.",
        });
      }

      if (oauthContext.state !== callbackState) {
        cookieStore.delete(CODEX_OAUTH_COOKIE_NAME);
        return yield* new ValidationError({
          message: "Invalid OAuth state. Please restart authentication.",
        });
      }

      const oauthResult = yield* Effect.tryPromise({
        try: () =>
          codexProvider.exchangeCode(code, CODEX_BROWSER_REDIRECT_URI, oauthContext.codeVerifier),
        catch: (cause) => new DatabaseError({ cause }),
      });

      cookieStore.delete(CODEX_OAUTH_COOKIE_NAME);

      const chatgptAccountId = oauthResult.accountId || null;
      const workspaceAccountId = oauthResult.workspaceId || chatgptAccountId || null;
      const workspaceEmail = workspaceAccountId ? `codex-${workspaceAccountId}` : null;

      let existingAccount = null;

      if (workspaceEmail) {
        const [found] = yield* Effect.tryPromise({
          try: () =>
            db
              .select()
              .from(providerAccount)
              .where(
                and(
                  eq(providerAccount.userId, userId),
                  eq(providerAccount.provider, "codex"),
                  eq(providerAccount.email, workspaceEmail)
                )
              )
              .limit(1),
          catch: (cause) => new DatabaseError({ cause }),
        });
        existingAccount = found || null;
      }

      if (
        !existingAccount &&
        chatgptAccountId &&
        (!workspaceAccountId || workspaceAccountId === chatgptAccountId)
      ) {
        const [found] = yield* Effect.tryPromise({
          try: () =>
            db
              .select()
              .from(providerAccount)
              .where(
                and(
                  eq(providerAccount.userId, userId),
                  eq(providerAccount.provider, "codex"),
                  eq(providerAccount.accountId, chatgptAccountId)
                )
              )
              .limit(1),
          catch: (cause) => new DatabaseError({ cause }),
        });
        existingAccount = found || null;
      }

      if (existingAccount) {
        yield* Effect.tryPromise({
          try: () =>
            db
              .update(providerAccount)
              .set({
                accessToken: encrypt(oauthResult.accessToken),
                refreshToken: encrypt(oauthResult.refreshToken),
                expiresAt: oauthResult.expiresAt,
                ...(chatgptAccountId && { accountId: chatgptAccountId }),
                isActive: true,
              })
              .where(eq(providerAccount.id, existingAccount!.id)),
          catch: (cause) => new DatabaseError({ cause }),
        });

        yield* Effect.sync(() => revalidatePath("/dashboard/accounts"));

        return {
          email: existingAccount.email || `codex-${chatgptAccountId || "unknown"}`,
          isUpdate: true,
        };
      }

      const countResults = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ value: countFn() })
            .from(providerAccount)
            .where(
              and(
                eq(providerAccount.userId, userId),
                eq(providerAccount.provider, "codex")
              )
            ),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const accountCount = countResults[0].value;
      const email = workspaceEmail || `codex-${Date.now()}`;

      yield* Effect.tryPromise({
        try: () =>
          db.insert(providerAccount).values({
            userId,
            provider: "codex",
            name: `Codex ${accountCount + 1}`,
            accessToken: encrypt(oauthResult.accessToken),
            refreshToken: encrypt(oauthResult.refreshToken),
            expiresAt: oauthResult.expiresAt,
            email,
            accountId: chatgptAccountId,
            isActive: true,
          }),
        catch: (cause) => new DatabaseError({ cause }),
      });

      yield* Effect.sync(() => revalidatePath("/dashboard/accounts"));

      return { email, isUpdate: false };
    }),
    MainLayer
  );
}

/**
 * Get Kiro OAuth authorization URL (browser flow)
 */
export async function getKiroAuthUrl(): Promise<ActionResult<{ authUrl: string }>> {
  return runServerAction(
    Effect.gen(function* () {
      yield* requireUserId;

      const state = generateKiroState();
      const codeVerifier = generateKiroCodeVerifier();
      const authUrl = yield* Effect.tryPromise({
        try: () => buildKiroAuthUrl(state, codeVerifier),
        catch: (cause) => new DatabaseError({ cause }),
      });

      const cookieStore = yield* Effect.tryPromise({
        try: () => cookies(),
        catch: (cause) => new DatabaseError({ cause }),
      });

      const context: KiroOAuthContext = { state, codeVerifier };
      cookieStore.set(KIRO_OAUTH_COOKIE_NAME, encrypt(JSON.stringify(context)), {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        maxAge: 10 * 60,
        path: "/",
      });

      return { authUrl };
    }),
    MainLayer
  );
}

/**
 * Exchange Kiro OAuth callback URL for tokens and create/update account
 */
export async function exchangeKiroOAuthCode(
  callbackUrl: string
): Promise<ActionResult<{ email: string; isUpdate: boolean }>> {
  return runServerAction(
    Effect.gen(function* () {
      const userId = yield* requireUserId;
      const db = yield* DatabaseService;

      if (!callbackUrl || typeof callbackUrl !== "string") {
        return yield* new ValidationError({ message: "Callback URL is required" });
      }

      let url: URL;
      try {
        url = new URL(callbackUrl);
      } catch {
        return yield* new ValidationError({ message: "Invalid URL format" });
      }

      const error = url.searchParams.get("error");
      if (error) {
        const message = url.searchParams.get("error_description") || error;
        return yield* new ValidationError({ message: `Kiro OAuth error: ${message}` });
      }

      const code = url.searchParams.get("code");
      if (!code) {
        return yield* new ValidationError({
          message:
            "No authorization code found in URL. Make sure you copied the complete URL from your browser.",
        });
      }

      const callbackState = url.searchParams.get("state");
      if (!callbackState) {
        return yield* new ValidationError({
          message: "Missing OAuth state. Please restart authentication.",
        });
      }

      const cookieStore = yield* Effect.tryPromise({
        try: () => cookies(),
        catch: (cause) => new DatabaseError({ cause }),
      });

      const contextCookie = cookieStore.get(KIRO_OAUTH_COOKIE_NAME);
      if (!contextCookie?.value) {
        return yield* new ValidationError({
          message: "Session expired. Please restart authentication.",
        });
      }

      let oauthContext: KiroOAuthContext;
      try {
        oauthContext = JSON.parse(decrypt(contextCookie.value)) as KiroOAuthContext;
      } catch {
        cookieStore.delete(KIRO_OAUTH_COOKIE_NAME);
        return yield* new ValidationError({
          message: "Invalid authentication state. Please restart authentication.",
        });
      }

      if (!oauthContext.codeVerifier || !oauthContext.state) {
        cookieStore.delete(KIRO_OAUTH_COOKIE_NAME);
        return yield* new ValidationError({
          message: "Invalid authentication context. Please restart authentication.",
        });
      }

      if (oauthContext.state !== callbackState) {
        cookieStore.delete(KIRO_OAUTH_COOKIE_NAME);
        return yield* new ValidationError({
          message: "Invalid OAuth state. Please restart authentication.",
        });
      }

      const oauthResult = yield* Effect.tryPromise({
        try: () => kiroProvider.exchangeCode(code, KIRO_BROWSER_REDIRECT_URI, oauthContext.codeVerifier),
        catch: (cause) => new DatabaseError({ cause }),
      });

      cookieStore.delete(KIRO_OAUTH_COOKIE_NAME);

      const accountId = oauthResult.accountId || null;
      const email = accountId ? `kiro-${accountId}` : `kiro-${Date.now()}`;

      let existingAccount = null;

      {
        const [found] = yield* Effect.tryPromise({
          try: () =>
            db
              .select()
              .from(providerAccount)
              .where(
                and(
                  eq(providerAccount.userId, userId),
                  eq(providerAccount.provider, "kiro"),
                  eq(providerAccount.email, email)
                )
              )
              .limit(1),
          catch: (cause) => new DatabaseError({ cause }),
        });
        existingAccount = found || null;
      }

      if (!existingAccount && accountId) {
        const [found] = yield* Effect.tryPromise({
          try: () =>
            db
              .select()
              .from(providerAccount)
              .where(
                and(
                  eq(providerAccount.userId, userId),
                  eq(providerAccount.provider, "kiro"),
                  eq(providerAccount.accountId, accountId)
                )
              )
              .limit(1),
          catch: (cause) => new DatabaseError({ cause }),
        });
        existingAccount = found || null;
      }

      if (existingAccount) {
        yield* Effect.tryPromise({
          try: () =>
            db
              .update(providerAccount)
              .set({
                accessToken: encrypt(oauthResult.accessToken),
                refreshToken: encrypt(oauthResult.refreshToken),
                expiresAt: oauthResult.expiresAt,
                ...(accountId ? { accountId } : {}),
                ...(oauthResult.email ? { email: oauthResult.email } : {}),
                isActive: true,
              })
              .where(eq(providerAccount.id, existingAccount!.id)),
          catch: (cause) => new DatabaseError({ cause }),
        });

        yield* Effect.sync(() => revalidatePath("/dashboard/accounts"));

        return {
          email: existingAccount.email || email,
          isUpdate: true,
        };
      }

      const countResults = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ value: countFn() })
            .from(providerAccount)
            .where(
              and(
                eq(providerAccount.userId, userId),
                eq(providerAccount.provider, "kiro")
              )
            ),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const accountCount = countResults[0].value;

      yield* Effect.tryPromise({
        try: () =>
          db.insert(providerAccount).values({
            userId,
            provider: "kiro",
            name: `Kiro ${accountCount + 1}`,
            accessToken: encrypt(oauthResult.accessToken),
            refreshToken: encrypt(oauthResult.refreshToken),
            expiresAt: oauthResult.expiresAt,
            email,
            accountId,
            isActive: true,
          }),
        catch: (cause) => new DatabaseError({ cause }),
      });

      yield* Effect.sync(() => revalidatePath("/dashboard/accounts"));

      return { email, isUpdate: false };
    }),
    MainLayer
  );
}

/**
 * Initiate Codex Device Code Flow
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
  return runServerAction(
    Effect.gen(function* () {
      yield* requireUserId;

      const deviceCodeInfo = yield* Effect.tryPromise({
        try: () => initiateCodexDeviceCodeFlow(),
        catch: (cause) => new DatabaseError({ cause }),
      });

      const cookieStore = yield* Effect.tryPromise({
        try: () => cookies(),
        catch: (cause) => new DatabaseError({ cause }),
      });

      cookieStore.set(
        `codex_cv_${deviceCodeInfo.deviceAuthId}`,
        encrypt(deviceCodeInfo.codeVerifier),
        {
          httpOnly: true,
          secure: true,
          sameSite: "strict",
          maxAge: deviceCodeInfo.expiresIn + 60,
          path: "/",
        }
      );

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { codeVerifier: _cv, ...data } = deviceCodeInfo;
      return data;
    }),
    MainLayer
  );
}

/**
 * Poll Codex device code authorization status
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
  return runServerAction(
    Effect.gen(function* () {
      const userId = yield* requireUserId;
      const db = yield* DatabaseService;

      const cookieStore = yield* Effect.tryPromise({
        try: () => cookies(),
        catch: (cause) => new DatabaseError({ cause }),
      });

      const cvCookie = cookieStore.get(`codex_cv_${deviceAuthId}`);
      if (!cvCookie?.value) {
        return yield* new ValidationError({
          message: "Session expired. Please restart authentication.",
        });
      }
      const codeVerifier = decrypt(cvCookie.value);

      const result = yield* Effect.tryPromise({
        try: () => pollCodexDeviceCodeAuthorization(deviceAuthId, userCode, codeVerifier),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if ("pending" in result) {
        return { status: "pending" as const };
      }

      if ("error" in result) {
        const errorMsg =
          typeof result.error === "string"
            ? result.error
            : (result.error as Record<string, unknown>)?.message as string ||
              JSON.stringify(result.error);
        return { status: "error" as const, message: errorMsg };
      }

      const oauthResult = result;
      const chatgptAccountId = oauthResult.accountId || null;
      const workspaceAccountId = oauthResult.workspaceId || chatgptAccountId || null;
      const workspaceEmail = workspaceAccountId ? `codex-${workspaceAccountId}` : null;

      cookieStore.delete(`codex_cv_${deviceAuthId}`);

      let existingAccount = null;

      if (workspaceEmail) {
        const [found] = yield* Effect.tryPromise({
          try: () =>
            db
              .select()
              .from(providerAccount)
              .where(
                and(
                  eq(providerAccount.userId, userId),
                  eq(providerAccount.provider, "codex"),
                  eq(providerAccount.email, workspaceEmail)
                )
              )
              .limit(1),
          catch: (cause) => new DatabaseError({ cause }),
        });
        existingAccount = found || null;
      }

      if (
        !existingAccount &&
        chatgptAccountId &&
        (!workspaceAccountId || workspaceAccountId === chatgptAccountId)
      ) {
        const [found] = yield* Effect.tryPromise({
          try: () =>
            db
              .select()
              .from(providerAccount)
              .where(
                and(
                  eq(providerAccount.userId, userId),
                  eq(providerAccount.provider, "codex"),
                  eq(providerAccount.accountId, chatgptAccountId)
                )
              )
              .limit(1),
          catch: (cause) => new DatabaseError({ cause }),
        });
        existingAccount = found || null;
      }

      if (existingAccount) {
        yield* Effect.tryPromise({
          try: () =>
            db
              .update(providerAccount)
              .set({
                accessToken: encrypt(oauthResult.accessToken),
                refreshToken: encrypt(oauthResult.refreshToken),
                expiresAt: oauthResult.expiresAt,
                ...(chatgptAccountId && { accountId: chatgptAccountId }),
                isActive: true,
              })
              .where(eq(providerAccount.id, existingAccount!.id)),
          catch: (cause) => new DatabaseError({ cause }),
        });

        yield* Effect.sync(() => revalidatePath("/dashboard/accounts"));

        return {
          status: "success" as const,
          email: existingAccount.email || `codex-${chatgptAccountId || "unknown"}`,
          isUpdate: true,
        };
      }

      const countResults = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ value: countFn() })
            .from(providerAccount)
            .where(
              and(
                eq(providerAccount.userId, userId),
                eq(providerAccount.provider, "codex")
              )
            ),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const accountCount = countResults[0].value;
      const email = workspaceEmail || `codex-${Date.now()}`;

      yield* Effect.tryPromise({
        try: () =>
          db.insert(providerAccount).values({
            userId,
            provider: "codex",
            name: `Codex ${accountCount + 1}`,
            accessToken: encrypt(oauthResult.accessToken),
            refreshToken: encrypt(oauthResult.refreshToken),
            expiresAt: oauthResult.expiresAt,
            email,
            accountId: chatgptAccountId,
            isActive: true,
          }),
        catch: (cause) => new DatabaseError({ cause }),
      });

      yield* Effect.sync(() => revalidatePath("/dashboard/accounts"));

      return { status: "success" as const, email, isUpdate: false };
    }),
    MainLayer
  );
}

/**
 * Set the email/identifier for a Codex account
 */
export async function setCodexAccountEmail(
  accountId: string,
  email: string
): Promise<ActionResult> {
  return runServerAction(
    Effect.gen(function* () {
      const userId = yield* requireUserId;
      const db = yield* DatabaseService;

      const accounts = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(providerAccount)
            .where(
              and(
                eq(providerAccount.id, accountId),
                eq(providerAccount.userId, userId),
                eq(providerAccount.provider, "codex")
              )
            )
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (!accounts[0]) {
        return yield* new NotFoundError({ message: "Account not found" });
      }

      yield* Effect.tryPromise({
        try: () =>
          db
            .update(providerAccount)
            .set({
              email: email.trim(),
              name: `Codex (${email.trim()})`,
            })
            .where(eq(providerAccount.id, accountId)),
        catch: (cause) => new DatabaseError({ cause }),
      });

      yield* Effect.sync(() => revalidatePath("/dashboard/accounts"));
    }),
    MainLayer
  );
}
