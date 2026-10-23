import { Buffer } from "node:buffer";
import { eq } from "drizzle-orm";

import { db, providerAccount, type ProviderAccount } from "@opendum/database";
import { decrypt, encrypt } from "#web/lib/encryption.js";
import { Effect } from "effect";
import { fetchExternalEffect } from "#web/lib/external.js";
import { fromPromise } from "#web/lib/task.js";
import { badRequest, unavailable } from "#web/errors.js";
import type { OAuthResult } from "../types.js";
import { formatProviderHttpError } from "../provider-http-errors.js";
import {
  BROWSER_REDIRECT_URI,
  CLIENT_ID,
  CODEX_CHAT_USER_AGENT,
  DEVICE_CODE_ENDPOINT,
  DEVICE_REDIRECT_URI,
  DEVICE_TOKEN_ENDPOINT,
  DEVICE_VERIFICATION_URL,
  REFRESH_BUFFER_SECONDS,
  TOKEN_ENDPOINT,
} from "./constants.js";

interface CodexTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  id_token?: string;
}

interface CodexDeviceCodeResponse {
  device_auth_id: string;
  user_code: string;
  interval?: string | number;
  expires_in?: number;
}

interface CodexDeviceTokenResponse {
  authorization_code: string;
  code_verifier: string;
}

interface ChatGPTSessionAccount {
  id?: string;
  planType?: string;
}

interface ChatGPTSessionUser {
  email?: string;
}

interface ChatGPTSessionPayload {
  accessToken?: string;
  expires?: string;
  account?: ChatGPTSessionAccount;
  user?: ChatGPTSessionUser;
}

export function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export const generateCodeChallenge = Effect.fn("codex.generateCodeChallenge")(function* (
  verifier: string
) {
  const data = new TextEncoder().encode(verifier);
  const digest = yield* fromPromise(
    () => crypto.subtle.digest("SHA-256", data),
    "Failed to build Codex code challenge"
  );
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
});

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  return value as Record<string, unknown>;
}

function extractOrganizationId(claims: Record<string, unknown> | null): string | null {
  if (!claims) {
    return null;
  }

  const organizations = claims.organizations;
  if (!Array.isArray(organizations)) {
    return null;
  }

  const normalizedOrganizations = organizations
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null);

  const defaultOrganization = normalizedOrganizations.find(
    (organization) => organization.is_default === true || organization.default === true
  );

  if (defaultOrganization) {
    const defaultOrganizationId = toNonEmptyString(defaultOrganization.id);
    if (defaultOrganizationId) {
      return defaultOrganizationId;
    }
  }

  for (const organization of normalizedOrganizations) {
    const organizationId = toNonEmptyString(organization.id);
    if (organizationId) {
      return organizationId;
    }
  }

  return null;
}

function parseJwtClaims(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;

    const payloadPart = parts[1];
    if (!payloadPart) return null;
    const payload = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    return asRecord(JSON.parse(Buffer.from(padded, "base64").toString("utf8")));
  } catch {
    return null;
  }
}

function extractEmailFromClaims(decoded: Record<string, unknown>): string | null {
  const profileClaims = asRecord(decoded["https://api.openai.com/profile"]);
  const emailCandidates = [
    toNonEmptyString(profileClaims?.email),
    toNonEmptyString(decoded.email),
  ];

  for (const candidate of emailCandidates) {
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function extractExpiresAtFromClaims(decoded: Record<string, unknown>): Date | null {
  if (typeof decoded.exp !== "number" || !Number.isFinite(decoded.exp) || decoded.exp <= 0) {
    return null;
  }

  const expiresAt = new Date(decoded.exp * 1000);
  return Number.isNaN(expiresAt.getTime()) ? null : expiresAt;
}

function extractWorkspaceIdFromClaims(decoded: Record<string, unknown>): string | null {
  const authClaims = asRecord(decoded["https://api.openai.com/auth"]);

  const workspaceCandidates = [
    toNonEmptyString(authClaims?.chatgpt_workspace_id),
    toNonEmptyString(authClaims?.workspace_id),
    toNonEmptyString(authClaims?.organization_id),
    extractOrganizationId(authClaims),
    toNonEmptyString(decoded.chatgpt_workspace_id),
    toNonEmptyString(decoded.workspace_id),
    toNonEmptyString(decoded.organization_id),
    extractOrganizationId(decoded),
  ];

  for (const candidate of workspaceCandidates) {
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function extractAccountIdFromClaims(decoded: Record<string, unknown>): string | null {
  const authClaims = asRecord(decoded["https://api.openai.com/auth"]);
  const accountCandidates = [
    toNonEmptyString(authClaims?.chatgpt_account_id),
    toNonEmptyString(decoded.chatgpt_account_id),
  ];

  for (const candidate of accountCandidates) {
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function extractTierFromClaims(decoded: Record<string, unknown>): string | null {
  const authClaims = asRecord(decoded["https://api.openai.com/auth"]);
  const tierCandidates = [
    toNonEmptyString(authClaims?.chatgpt_plan_type),
    toNonEmptyString(decoded.chatgpt_plan_type),
  ];

  for (const candidate of tierCandidates) {
    if (candidate) {
      return candidate.toLowerCase();
    }
  }

  return null;
}

function extractAccountIdFromJwt(token: string): string | null {
  const decoded = parseJwtClaims(token);
  return decoded ? extractAccountIdFromClaims(decoded) : null;
}

function extractWorkspaceIdFromJwt(token: string): string | null {
  const decoded = parseJwtClaims(token);
  return decoded ? extractWorkspaceIdFromClaims(decoded) : null;
}

function extractTierFromJwt(token: string): string | null {
  const decoded = parseJwtClaims(token);
  return decoded ? extractTierFromClaims(decoded) : null;
}

function parseChatGPTSessionPayload(sessionJson: string): ChatGPTSessionPayload {
  try {
    const parsed = JSON.parse(sessionJson) as unknown;
    const record = asRecord(parsed);
    if (!record) {
      throw new Error("ChatGPT session payload must be a JSON object");
    }
    return record as ChatGPTSessionPayload;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Invalid ChatGPT session JSON. Copy the full response from https://chatgpt.com/api/auth/session.", { cause: error });
    }
    throw error;
  }
}

function isTokenExpired(expiresAt: Date): boolean {
  const bufferMs = REFRESH_BUFFER_SECONDS * 1000;
  return Date.now() > expiresAt.getTime() - bufferMs;
}

type CredentialAccount = Pick<ProviderAccount, "id" | "accessToken" | "refreshToken" | "expiresAt" | "accountId">;

function buildOAuthResult(tokens: CodexTokenResponse, refreshToken?: string): OAuthResult {
  const accountId =
    (tokens.id_token ? extractAccountIdFromJwt(tokens.id_token) : null) ||
    extractAccountIdFromJwt(tokens.access_token);
  const workspaceId =
    (tokens.id_token ? extractWorkspaceIdFromJwt(tokens.id_token) : null) ||
    extractWorkspaceIdFromJwt(tokens.access_token) ||
    accountId;
  const tier =
    (tokens.id_token ? extractTierFromJwt(tokens.id_token) : null) ||
    extractTierFromJwt(tokens.access_token);

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || refreshToken || "",
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    email: "",
    accountId: accountId || undefined,
    workspaceId: workspaceId || undefined,
    tier: tier || undefined,
  };
}

export function buildOAuthResultFromChatGPTSession(sessionJson: string): OAuthResult {
  const session = parseChatGPTSessionPayload(sessionJson);
  const accessToken = toNonEmptyString(session.accessToken);
  if (!accessToken) {
    throw new Error("ChatGPT session JSON is missing accessToken");
  }

  const jwtClaims = parseJwtClaims(accessToken);
  if (!jwtClaims) {
    throw new Error("ChatGPT session accessToken is not a valid JWT. Copy the full response from https://chatgpt.com/api/auth/session.");
  }
  const accountId =
    (session.account ? toNonEmptyString(session.account.id) : null) ||
    extractAccountIdFromClaims(jwtClaims);
  const workspaceId = extractWorkspaceIdFromClaims(jwtClaims) || accountId;
  const tier =
    (session.account ? toNonEmptyString(session.account.planType)?.toLowerCase() ?? null : null) ||
    extractTierFromClaims(jwtClaims);
  const email =
    (session.user ? toNonEmptyString(session.user.email) : null) ||
    extractEmailFromClaims(jwtClaims) ||
    "";

  const expiresAt = extractExpiresAtFromClaims(jwtClaims);
  if (!expiresAt || expiresAt <= new Date()) {
    throw new Error("ChatGPT session accessToken is expired or missing an expiry. Please copy a fresh session JSON.");
  }

  return {
    accessToken,
    refreshToken: "",
    expiresAt,
    email,
    accountId: accountId || undefined,
    workspaceId: workspaceId || undefined,
    tier: tier || undefined,
  };
}

const exchangeCodexCode = Effect.fn("codex.exchangeCode")(function* (
  code: string,
  redirectUri: string,
  codeVerifier?: string
) {
  const body: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    redirect_uri: redirectUri || BROWSER_REDIRECT_URI,
  };

  if (codeVerifier) {
    body.code_verifier = codeVerifier;
  }

  const response = yield* fetchExternalEffect(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(body),
  });

  if (!response.ok) {
    const error = yield* readText(response);
    return yield* unavailable(
      formatProviderHttpError("Codex", response, error, {
        endpointLabel: "token exchange endpoint",
      })
    );
  }

  return buildOAuthResult(yield* readJson<CodexTokenResponse>(response));
});

const refreshCodexToken = Effect.fn("codex.refreshToken")(function* (refreshToken: string) {
  const response = yield* fetchExternalEffect(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });

  if (!response.ok) {
    const error = yield* readText(response);
    return yield* unavailable(
      formatProviderHttpError("Codex", response, error, {
        endpointLabel: "token refresh endpoint",
      })
    );
  }

  return buildOAuthResult(yield* readJson<CodexTokenResponse>(response), refreshToken);
});

const getValidCodexCredentials = Effect.fn("codex.getValidCredentials")(function* (
  account: CredentialAccount
) {
  let accessToken = decrypt(account.accessToken);
  const refreshTokenValue = account.refreshToken ? decrypt(account.refreshToken) : "";

  const resolvedAccountId = extractAccountIdFromJwt(accessToken);
  if (resolvedAccountId && resolvedAccountId !== account.accountId) {
    yield* fromPromise(
      () =>
        db
          .update(providerAccount)
          .set({ accountId: resolvedAccountId })
          .where(eq(providerAccount.id, account.id)),
      "Failed to persist Codex account id"
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          account.accountId = resolvedAccountId;
        })
      ),
      Effect.ignore
    );
  }

  if (!isTokenExpired(account.expiresAt)) return accessToken;

  if (!refreshTokenValue.trim()) {
    return yield* badRequest(
      "Codex ChatGPT session has expired. Reconnect this account with a fresh session JSON."
    );
  }

  const refreshed = yield* refreshCodexToken(refreshTokenValue).pipe(
    Effect.catch((error) =>
      new Date() >= account.expiresAt ? Effect.fail(error) : Effect.succeed(null)
    )
  );
  if (!refreshed) return accessToken;

  const updateData: Record<string, unknown> = {
    accessToken: encrypt(refreshed.accessToken),
    refreshToken: encrypt(refreshed.refreshToken ?? ""),
    expiresAt: refreshed.expiresAt,
  };

  if (refreshed.accountId) {
    updateData.accountId = refreshed.accountId;
    account.accountId = refreshed.accountId;
  }
  if (refreshed.tier) {
    updateData.tier = refreshed.tier;
  }

  yield* fromPromise(
    () =>
      db
        .update(providerAccount)
        .set(updateData)
        .where(eq(providerAccount.id, account.id)),
    "Failed to persist refreshed Codex credentials"
  );

  return refreshed.accessToken;
});

export const codexProvider = {
  exchangeCode: exchangeCodexCode,
  refreshToken: refreshCodexToken,
  getValidCredentials: getValidCodexCredentials,
};

export const initiateCodexDeviceCodeFlow = Effect.fn("codex.initiateDeviceCodeFlow")(function* () {
  const response = yield* fetchExternalEffect(DEVICE_CODE_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": CODEX_CHAT_USER_AGENT,
    },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });

  if (!response.ok) {
    const error = yield* readText(response);
    return yield* unavailable(
      formatProviderHttpError("Codex", response, error, {
        endpointLabel: "device code endpoint",
      })
    );
  }

  const data = yield* readJson<CodexDeviceCodeResponse>(response);
  return {
    deviceCode: data.device_auth_id,
    userCode: data.user_code,
    verificationUrl: DEVICE_VERIFICATION_URL,
    verificationUrlComplete: DEVICE_VERIFICATION_URL,
    expiresIn: data.expires_in ?? 900,
    interval: Number(data.interval) || 5,
  };
});

export const pollCodexDeviceCodeAuthorization = Effect.fn("codex.pollDeviceCodeAuthorization")(
  function* (deviceAuthId: string, userCode: string) {
    const response = yield* fetchExternalEffect(DEVICE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": CODEX_CHAT_USER_AGENT,
      },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    });

    if (response.ok) {
      const data = yield* readJson<CodexDeviceTokenResponse>(response);
      if (!data.authorization_code || !data.code_verifier) {
        return { error: "Codex device auth polling endpoint returned incomplete authorization data" };
      }
      return yield* codexProvider.exchangeCode(
        data.authorization_code,
        DEVICE_REDIRECT_URI,
        data.code_verifier
      );
    }

    if (response.status === 403 || response.status === 404) {
      return { pending: true as const, retryAfterSeconds: 8 };
    }

    const error = yield* readText(response);
    return {
      error: formatProviderHttpError("Codex", response, error, {
        endpointLabel: "device auth polling endpoint",
      }),
    };
});

function readText(response: Response) {
  return fromPromise(() => response.text(), "Failed to read Codex response");
}

function readJson<T>(response: Response) {
  return fromPromise(async () => ((await response.json()) as T), "Failed to read Codex response");
}
