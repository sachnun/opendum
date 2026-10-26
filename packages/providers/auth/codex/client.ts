import { Effect, Result } from "effect";

import { OAuthClient } from "@opendum/providers/auth/client";
import type { AuthRuntime } from "@opendum/providers/auth/runtime";
import { Jwt, Value } from "@opendum/providers";
import type { OAuthResult } from "@opendum/providers/auth/result";
import { tokenExpired, type CredentialAccount as Credential } from "@opendum/providers/auth/credentials";
import { Pkce } from "@opendum/providers/auth/pkce";
import { ProviderResponse, failedResult, pendingResult } from "@opendum/providers/auth/response";
import {
  AUTHORIZE_ENDPOINT,
  BROWSER_REDIRECT_URI,
  CLIENT_ID,
  ORIGINATOR,
  SCOPE,
  DEVICE_CODE_ENDPOINT,
  DEVICE_REDIRECT_URI,
  DEVICE_TOKEN_ENDPOINT,
  DEVICE_VERIFICATION_URL,
  REFRESH_BUFFER_SECONDS,
  TOKEN_ENDPOINT,
} from "@opendum/providers/auth/codex/constants";
import { USER_AGENT } from "@opendum/providers/auth/codex/user-agent";

interface CodexTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  id_token?: string;
}

interface DeviceCodeResponse {
  device_auth_id: string;
  user_code: string;
  interval?: string | number;
  expires_in?: number;
}

interface DeviceTokenResponse {
  authorization_code: string;
  code_verifier: string;
}

interface SessionAccount {
  id?: string;
  planType?: string;
}

interface SessionUser {
  email?: string;
}

interface SessionPayload {
  accessToken?: string;
  expires?: string;
  account?: SessionAccount;
  user?: SessionUser;
}

const FORM_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  Accept: "application/json",
};

const JSON_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
};

function pickToken(payload: unknown): CodexTokenResponse | null {
  const value = payload as Partial<CodexTokenResponse> | null;
  if (!value || typeof value.access_token !== "string" || !value.access_token) return null;
  return value as CodexTokenResponse;
}

class CodexClient extends OAuthClient {
  constructor(runtime: AuthRuntime) {
    super({ provider: "codex", label: "Codex" }, runtime);
  }
}

export function codexAuth(runtime: AuthRuntime) {
  const response = new ProviderResponse("Codex");
  const client = new CodexClient(runtime);

  function codeVerifier(): string {
    return Pkce.verifier();
  }

  const generateCodeChallenge = (verifier: string) => Pkce.challenge(verifier, "Codex");

  function organizationId(claims: Record<string, unknown>): string | null {
    const organizations = Array.isArray(claims.organizations) ? claims.organizations : [];
    const normalized = organizations
      .map((item) => Value.record(item))
      .filter((item): item is Record<string, unknown> => item !== null);
    const preferred = normalized.filter(
      (organization) => organization.is_default === true || organization.default === true
    );
    for (const organization of [...preferred, ...normalized]) {
      const value = Jwt.first(organization, ["id"]);
      if (value) return value;
    }
    return null;
  }

  function claimScope(claims: Record<string, unknown>, key: string): string {
    return Jwt.claim(Jwt.nested(claims, "https://api.openai.com/auth") ?? {}, key)
      || Jwt.claim(claims, key);
  }

  function claimsEmail(claims: Record<string, unknown>): string | null {
    const profile = Jwt.nested(claims, "https://api.openai.com/profile");
    return Jwt.claim(profile ?? {}, "email") || Jwt.claim(claims, "email") || null;
  }

  function claimsExpiry(claims: Record<string, unknown>): Date | null {
    const exp = claims.exp;
    if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) return null;
    const expiresAt = new Date(exp * 1000);
    return Number.isNaN(expiresAt.getTime()) ? null : expiresAt;
  }

  function claimsWorkspace(claims: Record<string, unknown>): string | null {
    const auth = Jwt.nested(claims, "https://api.openai.com/auth");
    for (const source of [auth ?? {}, claims]) {
      const value =
        Jwt.first(source, ["chatgpt_workspace_id", "workspace_id", "organization_id"])
        || organizationId(source);
      if (value) return value;
    }
    return null;
  }

  function claimsAccount(claims: Record<string, unknown>): string | null {
    return claimScope(claims, "chatgpt_account_id") || null;
  }

  function nonEmpty(value: unknown): string | null {
    return Value.trimmed(value) || null;
  }

  function jwtClaims(token: string): Record<string, unknown> | null {
    return Jwt.claims(token);
  }

  function claimsTier(claims: Record<string, unknown>): string | null {
    const value = claimScope(claims, "chatgpt_plan_type");
    return value ? value.toLowerCase() : null;
  }

  function jwtAccount(token: string): string | null {
    const claims = Jwt.claims(token);
    return claims ? claimsAccount(claims) : null;
  }

  function jwtWorkspace(token: string): string | null {
    const claims = Jwt.claims(token);
    return claims ? claimsWorkspace(claims) : null;
  }

  function jwtTier(token: string): string | null {
    const claims = Jwt.claims(token);
    return claims ? claimsTier(claims) : null;
  }

  function parseSession(sessionJson: string): Result.Result<SessionPayload, string> {
    const record = Value.jsonRecord(sessionJson);
    if (!record) {
      return Result.fail(
        "Invalid ChatGPT session JSON. Copy the full response from https://chatgpt.com/api/auth/session."
      );
    }
    return Result.succeed(record as SessionPayload);
  }

  type CredentialAccount = Credential & { accountId: string | null };

  function buildResult(tokens: CodexTokenResponse, refreshToken?: string): OAuthResult {
    const accountId =
      (tokens.id_token ? jwtAccount(tokens.id_token) : null) ||
      jwtAccount(tokens.access_token);
    const workspaceId =
      (tokens.id_token ? jwtWorkspace(tokens.id_token) : null) ||
      jwtWorkspace(tokens.access_token) ||
      accountId;
    const tier =
      (tokens.id_token ? jwtTier(tokens.id_token) : null) ||
      jwtTier(tokens.access_token);

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

  function sessionResult(sessionJson: string): Result.Result<OAuthResult, string> {
    const parsedSession = parseSession(sessionJson);
    if (Result.isFailure(parsedSession)) return Result.fail(parsedSession.failure);
    const session = parsedSession.success;
    const accessToken = nonEmpty(session.accessToken);
    if (!accessToken) {
      return Result.fail("ChatGPT session JSON is missing accessToken");
    }

    const claims = jwtClaims(accessToken);
    if (!claims) {
      return Result.fail(
        "ChatGPT session accessToken is not a valid JWT. Copy the full response from https://chatgpt.com/api/auth/session."
      );
    }
    const accountId =
      (session.account ? nonEmpty(session.account.id) : null) ||
      claimsAccount(claims);
    const workspaceId = claimsWorkspace(claims) || accountId;
    const tier =
      (session.account ? nonEmpty(session.account.planType)?.toLowerCase() ?? null : null) ||
      claimsTier(claims);
    const email =
      (session.user ? nonEmpty(session.user.email) : null) ||
      claimsEmail(claims) ||
      "";

    const expiresAt = claimsExpiry(claims);
    if (!expiresAt || expiresAt <= new Date()) {
      return Result.fail(
        "ChatGPT session accessToken is expired or missing an expiry. Please copy a fresh session JSON."
      );
    }

    return Result.succeed({
      accessToken,
      refreshToken: "",
      expiresAt,
      email,
      accountId: accountId || undefined,
      workspaceId: workspaceId || undefined,
      tier: tier || undefined,
    });
  }

  const exchangeCodexCode = (code: string, redirectUri: string, codeVerifier?: string) =>
    client.decode<CodexTokenResponse>(
      {
        url: TOKEN_ENDPOINT,
        endpoint: "token exchange endpoint",
        init: {
          method: "POST",
          headers: FORM_HEADERS,
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: CLIENT_ID,
            redirect_uri: redirectUri || BROWSER_REDIRECT_URI,
            ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
          }),
        },
      },
      pickToken
    ).pipe(Effect.map((data) => buildResult(data)));

  const refreshCodexToken = (refreshToken: string) =>
    client.decode<CodexTokenResponse>(
      {
        url: TOKEN_ENDPOINT,
        endpoint: "token refresh endpoint",
        init: {
          method: "POST",
          headers: FORM_HEADERS,
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: CLIENT_ID,
          }),
        },
      },
      pickToken
    ).pipe(Effect.map((data) => buildResult(data, refreshToken)));

  const validCredentials = Effect.fn("codex.getValidCredentials")(function* (
    account: CredentialAccount
  ) {
    const accessToken = runtime.store.decrypt(account.accessToken);
    const refreshTokenValue = account.refreshToken ? runtime.store.decrypt(account.refreshToken) : "";

    const resolvedAccountId = jwtAccount(accessToken);
    if (resolvedAccountId && resolvedAccountId !== account.accountId) {
      yield* runtime.saveAccountId(account.id, resolvedAccountId).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            account.accountId = resolvedAccountId;
          })
        ),
        Effect.ignore
      );
    }

    if (!tokenExpired(account.expiresAt, REFRESH_BUFFER_SECONDS)) return accessToken;

    if (!refreshTokenValue.trim()) {
      return yield* runtime.badRequest(
        "Codex ChatGPT session has expired. Reconnect this account with a fresh session JSON."
      );
    }

    const refreshed = yield* refreshCodexToken(refreshTokenValue).pipe(
      Effect.catch((error) =>
        new Date() >= account.expiresAt ? Effect.fail(error) : Effect.succeed(null)
      )
    );
    if (!refreshed) return accessToken;

    yield* runtime.store.save(
      account.id,
      { ...refreshed, refreshToken: refreshed.refreshToken ?? "" },
      {
        ...(refreshed.accountId ? { accountId: refreshed.accountId } : {}),
        ...(refreshed.tier ? { tier: refreshed.tier } : {}),
      },
      "Failed to persist refreshed Codex credentials"
    );

    return refreshed.accessToken;
  });

  const codexProvider = {
    exchangeCode: exchangeCodexCode,
    refreshToken: refreshCodexToken,
    getValidCredentials: validCredentials,
  };

  const startDeviceFlow = Effect.fn("codex.initiateDeviceCodeFlow")(function* () {
    const data = yield* client.decode<DeviceCodeResponse>(
      {
        url: DEVICE_CODE_ENDPOINT,
        endpoint: "device code endpoint",
        init: {
          method: "POST",
          headers: { ...JSON_HEADERS, "User-Agent": USER_AGENT },
          body: JSON.stringify({ client_id: CLIENT_ID }),
        },
      },
      (payload) => (payload as DeviceCodeResponse | null) ?? null
    );
    return {
      deviceCode: data.device_auth_id,
      userCode: data.user_code,
      verificationUrl: DEVICE_VERIFICATION_URL,
      verificationUrlComplete: DEVICE_VERIFICATION_URL,
      expiresIn: data.expires_in ?? 900,
      interval: Number(data.interval) || 5,
    };
  });

  const pollDeviceAuth = Effect.fn("codex.pollDeviceCodeAuthorization")(
    function* (deviceAuthId: string, userCode: string) {
      const result = yield* runtime.fetch(DEVICE_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
      });

      if (result.ok) {
        const data = yield* response.json<DeviceTokenResponse>(result);
        if (!data.authorization_code || !data.code_verifier) {
          return failedResult("Codex device auth polling endpoint returned incomplete authorization data");
        }
        return yield* codexProvider.exchangeCode(
          data.authorization_code,
          DEVICE_REDIRECT_URI,
          data.code_verifier
        );
      }

      if (result.status === 403 || result.status === 404) return pendingResult(8);

      const error = yield* response.text(result);
      return failedResult(response.failure(result, error, "device auth polling endpoint"));
  });

  const authUrl = Effect.fn("codex.buildAuthUrl")(function* (state: string) {
    const verifier = codeVerifier();
    const codeChallenge = yield* generateCodeChallenge(verifier);
    return {
      authUrl: `${AUTHORIZE_ENDPOINT}?${new URLSearchParams({
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: BROWSER_REDIRECT_URI,
        scope: SCOPE,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        state,
        originator: ORIGINATOR,
      }).toString()}`,
      state,
      codeVerifier: verifier,
    };
  });

  return {
    codexProvider,
    sessionResult,
    startDeviceFlow,
    pollDeviceAuth,
    codeVerifier,
    generateCodeChallenge,
    authUrl,
    BROWSER_REDIRECT_URI,
  };
}
