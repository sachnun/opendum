import { Effect } from "effect";
import { and, count as countFn, eq } from "drizzle-orm";

import type { CreateAccountInput } from "@opendum/providers/contract";

import { db, providerAccount } from "@opendum/database";
import { publishAccounts } from "#web/events/bus.js";
import { encrypt, hashString } from "#web/lib/encryption.js";
import { clearFails } from "#web/lib/proxy/auth.js";
import { fetchExternalEffect } from "#web/lib/external.js";
import { fromPromise } from "#web/lib/task.js";
import { providerModels } from "#web/lib/proxy/models.js";
import { API_BASE_URL as nvidiaApiBaseUrl } from "#web/lib/providers/nvidia/constants.js";
import { API_BASE_URL as openRouterApiBaseUrl } from "#web/lib/providers/openrouter/constants.js";
import { API_BASE_URL as zenmuxApiBaseUrl } from "#web/lib/providers/zenmux/constants.js";
import { API_BASE_URL as harborApiBaseUrl } from "#web/lib/providers/harbor/constants.js";
import { API_BASE_URL as hyperApiBaseUrl } from "#web/lib/providers/hyper/constants.js";
import { httpError, isChallenge } from "#web/lib/providers/provider-http-errors.js";
import { validationUrl } from "#web/lib/providers/cloudflare/constants.js";
import { KEY_PROVIDERS, type KeyProvider } from "@opendum/providers/provider-accounts";
import type { ServiceFailure } from "#web/errors.js";

const KEY_ACCOUNT_EXPIRY = new Date("2100-01-01T00:00:00.000Z");
const VALIDATION_TIMEOUT_MS = 15000;
const RELAY_ERROR_HEADER = "X-Opendum-Internal-Relay-Error";

const MODELS_VALIDATION = { validationPath: "/models", requireSuccessfulStatus: true, skipInference: false } as const;
const CHAT_AUTH_PROBE = { validationPath: "/chat/completions", requireSuccessfulStatus: false, skipInference: true } as const;

const KEY_SETTINGS = {
  nvidia_nim: { label: "Nvidia", baseUrl: nvidiaApiBaseUrl, modelMap: providerModels("nvidia_nim"), ...CHAT_AUTH_PROBE },
  openrouter: { label: "OpenRouter", baseUrl: openRouterApiBaseUrl, modelMap: providerModels("openrouter"), ...MODELS_VALIDATION },
  zenmux: { label: "ZenMux", baseUrl: zenmuxApiBaseUrl, modelMap: providerModels("zenmux"), ...CHAT_AUTH_PROBE },
  harbor: { label: "Harbor", baseUrl: harborApiBaseUrl, modelMap: providerModels("harbor"), ...MODELS_VALIDATION },
  hyper: { label: "Charm", baseUrl: hyperApiBaseUrl, modelMap: providerModels("hyper"), ...CHAT_AUTH_PROBE },
} satisfies Record<KeyProvider, { label: string; baseUrl: string; modelMap: Record<string, string>; validationPath: "/models" | "/chat/completions"; requireSuccessfulStatus: boolean; skipInference?: boolean }>;

type ConnectResult = { email: string; isUpdate: boolean };

function validationRequest(provider: KeyProvider, apiKey: string) {
  const { baseUrl, modelMap, validationPath, skipInference } = KEY_SETTINGS[provider];
  const validationModel = Object.values(modelMap)[0];
  const isPost = validationPath === "/chat/completions";
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" };
  let body: Record<string, unknown> | undefined;
  if (validationPath === "/chat/completions") {
    body = skipInference
      ? { model: validationModel, messages: [] }
      : { model: validationModel, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false };
  }
  return {
    validationModel,
    url: `${baseUrl}${validationPath}`,
    method: (isPost ? "POST" : "GET") as "POST" | "GET",
    headers,
    body,
  };
}

function failWith(message: string) {
  return { success: false as const, error: message };
}

const validateKey = Effect.fn("accountConnectors.validateApiKey")(function* (
  provider: KeyProvider,
  apiKey: string
) {
  const { label, validationPath, requireSuccessfulStatus } = KEY_SETTINGS[provider];
  const { validationModel, url, method, headers, body } = validationRequest(provider, apiKey);
  if (validationPath === "/chat/completions" && !validationModel) {
    return failWith(`${label} API key validation model is not configured.`);
  }

  const response = yield* fetchExternalEffect(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(
        new Response(null, {
          status: 599,
          headers: { [RELAY_ERROR_HEADER]: "timeout" },
        })
      )
    )
  );
  if (response.headers.get(RELAY_ERROR_HEADER) === "timeout") {
    return failWith(`${label} API key validation timed out. Please try again.`);
  }
  if (response.headers.get(RELAY_ERROR_HEADER) === "1") {
    return failWith(`Unable to validate ${label} API key through the proxy. Please try again.`);
  }

  const responseText = response.ok
    ? ""
    : yield* fromPromise(() => response.text().catch(() => ""), "Failed to read provider response");

  if (isChallenge(response, responseText)) {
    return failWith(
      httpError(label, response, responseText, { endpointLabel: "API key validation endpoint" })
    );
  }
  if (response.status === 401 || response.status === 403) {
    return failWith(`${label} API key is invalid.`);
  }
  if (requireSuccessfulStatus && !response.ok) {
    const normalizedBody = responseText.toLowerCase();
    if (
      normalizedBody.includes("authenticate") ||
      normalizedBody.includes("unauthorized") ||
      normalizedBody.includes("invalid api key") ||
      normalizedBody.includes("user not found")
    ) {
      return failWith(`${label} API key is invalid.`);
    }
    return failWith(`Unable to validate ${label} API key right now (HTTP ${response.status}). Please try again.`);
  }
  return { success: true as const, data: undefined };
});

const connectKeyProvider = Effect.fn("accountConnectors.apiKeyConnect")(function* (
  userId: string,
  provider: KeyProvider,
  apiKey: string,
  accountName?: string,
  platformKey?: string
) {
  const normalizedApiKey = apiKey.trim();
  if (!normalizedApiKey) return failWith("API key is required");
  const validationResult = yield* validateKey(provider, normalizedApiKey);
  if (!validationResult.success) return validationResult;

  const { label } = KEY_SETTINGS[provider];
  const identifier = `${provider}-${hashString(normalizedApiKey).slice(0, 16)}`;
  const normalizedAccountName = accountName?.trim();
  const normalizedPlatformKey = platformKey?.trim() || null;
  const existing = yield* fromPromise(
    () =>
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
    "Failed to load provider account"
  );
  const existingAccount = existing[0];
  if (existingAccount) {
    yield* fromPromise(
      () =>
        db
          .update(providerAccount)
          .set({
            accessToken: encrypt(normalizedApiKey),
            refreshToken: encrypt(normalizedApiKey),
            expiresAt: KEY_ACCOUNT_EXPIRY,
            ...(normalizedAccountName ? { name: normalizedAccountName } : {}),
            ...(normalizedPlatformKey ? { accountId: normalizedPlatformKey } : {}),
            isActive: true,
            disabledUntil: null,
          })
          .where(eq(providerAccount.id, existingAccount.id)),
      "Failed to update provider account"
    );
    yield* clearFails(existingAccount.id);
    return { success: true as const, data: { email: identifier, isUpdate: true } satisfies ConnectResult };
  }

  const countResult = yield* fromPromise(
    () =>
      db
        .select({ value: countFn() })
        .from(providerAccount)
        .where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, provider))),
    "Failed to count provider accounts"
  );
  yield* fromPromise(
    () =>
      db.insert(providerAccount).values({
        userId,
        provider,
        name: normalizedAccountName || `${label} ${(countResult[0]?.value ?? 0) + 1}`,
        accessToken: encrypt(normalizedApiKey),
        refreshToken: encrypt(normalizedApiKey),
        expiresAt: KEY_ACCOUNT_EXPIRY,
        email: identifier,
        ...(normalizedPlatformKey ? { accountId: normalizedPlatformKey } : {}),
        isActive: true,
      }),
    "Failed to create provider account"
  );
  return { success: true as const, data: { email: identifier, isUpdate: false } satisfies ConnectResult };
});

const connectCloudflare = Effect.fn("accountConnectors.connectCloudflare")(function* (
  userId: string,
  apiToken: string,
  cfAccountId: string,
  accountName?: string
) {
  const normalizedApiToken = apiToken.trim();
  const normalizedAccountId = cfAccountId.trim();
  if (!normalizedApiToken) return failWith("API token is required");
  if (!normalizedAccountId) return failWith("Cloudflare Account ID is required");

  const response = yield* fetchExternalEffect(validationUrl(normalizedAccountId), {
    method: "GET",
    headers: { Authorization: `Bearer ${normalizedApiToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(
        new Response(null, {
          status: 599,
          headers: { [RELAY_ERROR_HEADER]: "timeout" },
        })
      )
    )
  );
  if (response.headers.get(RELAY_ERROR_HEADER) === "timeout") {
    return failWith("Cloudflare validation timed out. Please try again.");
  }
  if (response.headers.get(RELAY_ERROR_HEADER) === "1") {
    return failWith("Unable to validate Cloudflare credentials through the proxy. Please try again.");
  }
  if (!response.ok) {
    const responseText = yield* fromPromise(
      () => response.text().catch(() => ""),
      "Failed to read provider response"
    );
    if (isChallenge(response, responseText)) {
      return failWith(
        httpError("Cloudflare", response, responseText, {
          endpointLabel: "credentials validation endpoint",
        })
      );
    }
    if (response.status === 401 || response.status === 403) {
      return failWith("Cloudflare API token is invalid.");
    }
    return failWith(`Unable to validate Cloudflare credentials (HTTP ${response.status}). Please try again.`);
  }

  const identifier = `workers_ai-${hashString(`${normalizedAccountId}:${normalizedApiToken}`).slice(0, 16)}`;
  const normalizedAccountName = accountName?.trim();
  const existing = yield* fromPromise(
    () =>
      db
        .select()
        .from(providerAccount)
        .where(
          and(
            eq(providerAccount.userId, userId),
            eq(providerAccount.provider, "workers_ai"),
            eq(providerAccount.email, identifier)
          )
        )
        .limit(1),
    "Failed to load provider account"
  );
  const existingAccount = existing[0];
  if (existingAccount) {
    yield* fromPromise(
      () =>
        db
          .update(providerAccount)
          .set({
            accessToken: encrypt(normalizedApiToken),
            refreshToken: encrypt(normalizedApiToken),
            expiresAt: KEY_ACCOUNT_EXPIRY,
            accountId: normalizedAccountId,
            ...(normalizedAccountName ? { name: normalizedAccountName } : {}),
            isActive: true,
            disabledUntil: null,
          })
          .where(eq(providerAccount.id, existingAccount.id)),
      "Failed to update provider account"
    );
    yield* clearFails(existingAccount.id);
    return { success: true as const, data: { email: identifier, isUpdate: true } satisfies ConnectResult };
  }

  const countResult = yield* fromPromise(
    () =>
      db
        .select({ value: countFn() })
        .from(providerAccount)
        .where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, "workers_ai"))),
    "Failed to count provider accounts"
  );
  yield* fromPromise(
    () =>
      db.insert(providerAccount).values({
        userId,
        provider: "workers_ai",
        name: normalizedAccountName || `Cloudflare ${(countResult[0]?.value ?? 0) + 1}`,
        accessToken: encrypt(normalizedApiToken),
        refreshToken: encrypt(normalizedApiToken),
        expiresAt: KEY_ACCOUNT_EXPIRY,
        email: identifier,
        accountId: normalizedAccountId,
        isActive: true,
      }),
    "Failed to create provider account"
  );
  return { success: true as const, data: { email: identifier, isUpdate: false } satisfies ConnectResult };
});

type Connector = (
  userId: string,
  input: CreateAccountInput
) => Effect.Effect<
  { success: true; data: ConnectResult } | { success: false; error: string },
  ServiceFailure
>;

const ACCOUNT_CONNECTORS: Record<string, Connector> = {
  ...Object.fromEntries(
    KEY_PROVIDERS.map((provider) => [
      provider,
      (userId: string, input: CreateAccountInput) =>
        connectKeyProvider(userId, provider, input.token, input.name, input.platformKey),
    ])
  ),
  workers_ai: (userId: string, input: CreateAccountInput) =>
    connectCloudflare(userId, input.token, input.cfAccountId ?? "", input.name),
};

export const createAccount = Effect.fn("accountConnectors.createAccount")(function* (
  userId: string,
  input: CreateAccountInput
) {
  const connect = ACCOUNT_CONNECTORS[input.provider];
  if (!connect) {
    return failWith(`${input.provider} does not support direct API-key connection.`);
  }

  const result = yield* connect(userId, input).pipe(
    Effect.catch((failure) => Effect.succeed(failWith(failure.message)))
  );
  if (result.success) publishAccounts(userId);
  return result;
});
