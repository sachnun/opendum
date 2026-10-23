import { and, count as countFn, eq } from "drizzle-orm";
import { Effect } from "effect";

import type { ConnectCodexSessionInput, ExchangeOAuthInput, GetAuthUrlInput, InitiateDeviceAuthInput, PollDeviceAuthInput } from "@opendum/providers/contract";
import { db, providerAccount } from "@opendum/database";
import { publishAccountsChanged } from "#web/events/bus.js";
import { encrypt } from "#web/lib/encryption.js";
import { antigravityProvider } from "#web/lib/providers/antigravity/index.js";
import { CLIENT_ID as antigravityClientId, REDIRECT_URI as antigravityRedirectUri, SCOPES as antigravityScopes } from "#web/lib/providers/antigravity/constants.js";
import { AUTHORIZE_ENDPOINT as codexAuthorizeEndpoint, BROWSER_REDIRECT_URI as codexBrowserRedirectUri, CLIENT_ID as codexClientId, ORIGINATOR as codexOriginator, SCOPE as codexScope, buildOAuthResultFromChatGPTSession, codexProvider, generateCodeChallenge as generateCodexCodeChallenge, generateCodeVerifier as generateCodexCodeVerifier, initiateCodexDeviceCodeFlow, pollCodexDeviceCodeAuthorization } from "#web/lib/providers/codex/index.js";
import { BROWSER_REDIRECT_URI as kiroBrowserRedirectUri, buildKiroAuthUrl, generateCodeVerifier as generateKiroCodeVerifier, kiroProvider } from "#web/lib/providers/kiro/index.js";
import { initiateWorkbuddyDeviceCodeFlow, pollWorkbuddyDeviceCodeAuthorization } from "#web/lib/providers/workbuddy/index.js";
import { exchangePerchOAuthCode, initiatePerchOAuth } from "#web/lib/providers/perch/index.js";
import { initiateClineDeviceCodeFlow, pollClineDeviceCodeAuthorization } from "#web/lib/providers/cline/index.js";
import { clearRefreshFailCount } from "#web/lib/proxy/auth.js";
import type { OAuthResult } from "#web/lib/providers/types.js";
import type { DeviceProviderKey, OAuthProviderKey } from "@opendum/providers/provider-accounts";
import type { ActionResult } from "#web/utils/api.js";
import { fromPromise } from "#web/lib/task.js";
import { ServiceFailure, badRequest, internal } from "#web/errors.js";
import { trackProviderEmail } from "./points.js";

const GOOGLE_OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";

type ProviderAccountKey = OAuthProviderKey | DeviceProviderKey;
type AuthUrlResult = { authUrl: string; state: string | null; codeVerifier: string | null };
type OAuthAccountOptions = {
  email?: string;
  accountId?: string | null;
  dedupeByAccountId?: boolean;
};

const GOOGLE_OAUTH_CONFIG = {
  antigravity: { clientId: antigravityClientId, redirectUri: antigravityRedirectUri, scopes: antigravityScopes },
};

function generateOAuthState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

function buildGoogleOAuthUrl(): string {
  const config = GOOGLE_OAUTH_CONFIG.antigravity;
  const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code", scope: config.scopes.join(" "), access_type: "offline", prompt: "consent" });
  return `${GOOGLE_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

const buildCodexOAuthUrl = Effect.fn("accountAuth.buildCodexOAuthUrl")(function* (state: string) {
  const codeVerifier = generateCodexCodeVerifier();
  const codeChallenge = yield* generateCodexCodeChallenge(codeVerifier);
  const params = new URLSearchParams({ response_type: "code", client_id: codexClientId, redirect_uri: codexBrowserRedirectUri, scope: codexScope, code_challenge: codeChallenge, code_challenge_method: "S256", id_token_add_organizations: "true", codex_cli_simplified_flow: "true", state, originator: codexOriginator });
  return { authUrl: `${codexAuthorizeEndpoint}?${params.toString()}`, state, codeVerifier };
});

const buildKiroOAuthUrl = Effect.fn("accountAuth.buildKiroOAuthUrl")(function* (state: string) {
  const codeVerifier = generateKiroCodeVerifier();
  return { authUrl: yield* buildKiroAuthUrl(state, codeVerifier), state, codeVerifier };
});

const OAUTH_PROVIDERS: Record<OAuthProviderKey, {
  label: string;
  accountIdPrefix?: string;
  requiresCodeVerifier?: boolean;
  buildAuthUrl: () => Effect.Effect<AuthUrlResult, ServiceFailure>;
  exchangeCode: (code: string, codeVerifier?: string | null) => Effect.Effect<OAuthResult, ServiceFailure>;
}> = {
  antigravity: {
    label: "Antigravity",
    buildAuthUrl: () => Effect.succeed({ authUrl: buildGoogleOAuthUrl(), state: null, codeVerifier: null }),
    exchangeCode: (code) => antigravityProvider.exchangeCode(code, antigravityRedirectUri),
  },
  codex: {
    label: "Codex",
    accountIdPrefix: "codex",
    requiresCodeVerifier: true,
    buildAuthUrl: () => buildCodexOAuthUrl(generateOAuthState()),
    exchangeCode: (code, codeVerifier) => codexProvider.exchangeCode(code, codexBrowserRedirectUri, codeVerifier ?? undefined),
  },
  kiro: {
    label: "Kiro",
    accountIdPrefix: "kiro",
    requiresCodeVerifier: true,
    buildAuthUrl: () => buildKiroOAuthUrl(generateOAuthState()),
    exchangeCode: (code, codeVerifier) => kiroProvider.exchangeCode(code, kiroBrowserRedirectUri, codeVerifier ?? undefined),
  },
  perch: {
    label: "Perch",
    requiresCodeVerifier: true,
    buildAuthUrl: () =>
      initiatePerchOAuth().pipe(
        Effect.map((result) => ({ authUrl: result.authUrl, state: null, codeVerifier: result.codeVerifier }))
      ),
    exchangeCode: (code, codeVerifier) => exchangePerchOAuthCode(code, codeVerifier ?? ""),
  },
};

const DEVICE_PROVIDERS = {
  codex: {
    label: "Codex",
    emailPrefix: "codex",
    initiate: initiateCodexDeviceCodeFlow,
    poll: (input: PollDeviceAuthInput) => pollCodexDeviceCodeAuthorization(input.deviceCode, input.userCode ?? ""),
  },
  workbuddy: {
    label: "WorkBuddy",
    emailPrefix: "workbuddy",
    initiate: () => initiateWorkbuddyDeviceCodeFlow(),
    poll: (input: PollDeviceAuthInput) => pollWorkbuddyDeviceCodeAuthorization(input.deviceCode),
  },
  cline: {
    label: "Cline",
    emailPrefix: "cline",
    initiate: () => initiateClineDeviceCodeFlow(),
    poll: (input: PollDeviceAuthInput) => pollClineDeviceCodeAuthorization(input.deviceCode),
  },
} satisfies Record<DeviceProviderKey, { label: string; emailPrefix: string; initiate: () => Effect.Effect<unknown, ServiceFailure>; poll: (input: PollDeviceAuthInput) => Effect.Effect<unknown, ServiceFailure> }>;

function encryptOptionalRefreshToken(refreshToken: string | undefined): string {
  return refreshToken ? encrypt(refreshToken) : "";
}

const upsertOAuthAccount = Effect.fn("accountAuth.upsertOAuthAccount")(function* (
  userId: string,
  provider: ProviderAccountKey,
  label: string,
  oauthResult: OAuthResult,
  options: OAuthAccountOptions = {}
) {
  const email = options.email || oauthResult.email || `${provider}-${Date.now()}`;
  const accountId = options.accountId ?? oauthResult.accountId ?? null;
  const foundByEmail = yield* fromPromise(
    () =>
      db
        .select({ id: providerAccount.id, email: providerAccount.email })
        .from(providerAccount)
        .where(
          and(
            eq(providerAccount.userId, userId),
            eq(providerAccount.provider, provider),
            eq(providerAccount.email, email)
          )
        )
        .limit(1),
    "Failed to load provider account"
  );
  const foundByAccountId =
    !foundByEmail[0] && accountId && options.dedupeByAccountId
      ? yield* fromPromise(
          () =>
            db
              .select({ id: providerAccount.id, email: providerAccount.email })
              .from(providerAccount)
              .where(
                and(
                  eq(providerAccount.userId, userId),
                  eq(providerAccount.provider, provider),
                  eq(providerAccount.accountId, accountId)
                )
              )
              .limit(1),
          "Failed to load provider account"
        )
      : [];
  const existingAccount = foundByEmail[0] ?? foundByAccountId[0] ?? null;

  if (existingAccount) {
    const resolvedEmail =
      oauthResult.email && email === oauthResult.email
        ? oauthResult.email
        : existingAccount.email || email;
    yield* fromPromise(
      () =>
        db
          .update(providerAccount)
          .set({
            accessToken: encrypt(oauthResult.accessToken),
            refreshToken: encryptOptionalRefreshToken(oauthResult.refreshToken),
            expiresAt: oauthResult.expiresAt,
            email: resolvedEmail,
            ...(oauthResult.projectId ? { projectId: oauthResult.projectId } : {}),
            ...(oauthResult.tier ? { tier: oauthResult.tier } : {}),
            ...(accountId ? { accountId } : {}),
            isActive: true,
            disabledUntil: null,
          })
          .where(eq(providerAccount.id, existingAccount.id)),
      "Failed to update provider account"
    );
    yield* clearRefreshFailCount(existingAccount.id);
    yield* trackProviderEmail(userId, resolvedEmail);
    publishAccountsChanged(userId);
    return { email: resolvedEmail, isUpdate: true };
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
        name: `${label} ${(countResult[0]?.value ?? 0) + 1}`,
        accessToken: encrypt(oauthResult.accessToken),
        refreshToken: encryptOptionalRefreshToken(oauthResult.refreshToken),
        expiresAt: oauthResult.expiresAt,
        email,
        projectId: oauthResult.projectId,
        tier: oauthResult.tier,
        accountId,
        isActive: true,
      }),
    "Failed to create provider account"
  );
  yield* trackProviderEmail(userId, email);
  publishAccountsChanged(userId);
  return { email, isUpdate: false };
});

function oauthAccountOptions(provider: OAuthProviderKey, config: (typeof OAUTH_PROVIDERS)[OAuthProviderKey], oauthResult: OAuthResult): OAuthAccountOptions | undefined {
  if (provider === "codex") {
    const chatgptAccountId = oauthResult.accountId || null;
    const workspaceAccountId = oauthResult.workspaceId || chatgptAccountId || null;
    const isPersonalAccount = !workspaceAccountId || workspaceAccountId === chatgptAccountId;
    return {
      email: oauthResult.email && isPersonalAccount ? oauthResult.email : workspaceAccountId ? `codex-${workspaceAccountId}` : `codex-${Date.now()}`,
      accountId: chatgptAccountId,
      dedupeByAccountId: !workspaceAccountId || workspaceAccountId === chatgptAccountId,
    };
  }

  if (provider === "kiro") {
    return {
      email: oauthResult.email || `kiro-${Date.now()}`,
      accountId: oauthResult.accountId || null,
      dedupeByAccountId: false,
    };
  }

  if (!config.accountIdPrefix) return undefined;
  const accountId = oauthResult.accountId || null;
  return { email: accountId ? `${config.accountIdPrefix}-${accountId}` : `${config.accountIdPrefix}-${Date.now()}`, accountId, dedupeByAccountId: true };
}

function validateOAuthContext(config: (typeof OAUTH_PROVIDERS)[OAuthProviderKey], input: ExchangeOAuthInput, parsedState: string | null): ServiceFailure | null {
  if (!config.requiresCodeVerifier) return null;
  if (parsedState !== input.state) return badRequest("Invalid OAuth state. Please restart authentication.");
  if (!input.codeVerifier) return badRequest("Missing authentication context. Please restart authentication.");
  return null;
}

function parseOAuthCallbackUrl(callbackUrl: string, providerLabel: string) {
  if (!callbackUrl || typeof callbackUrl !== "string") return badRequest("Callback URL is required");

  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    return badRequest("Invalid URL format");
  }

  const error = url.searchParams.get("error");
  if (error) {
    return badRequest(`${providerLabel} OAuth error: ${url.searchParams.get("error_description") || error}`);
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return badRequest("No authorization code found in URL. Make sure you copied the complete URL from your browser.");
  }
  return { code, state: url.searchParams.get("state") };
}

export const getAccountAuthUrl = Effect.fn("accountAuth.getAuthUrl")(function* (input: GetAuthUrlInput) {
  const config = OAUTH_PROVIDERS[input.provider];
  const data = yield* config.buildAuthUrl().pipe(
    Effect.mapError((failure) => internal(failure.message, failure.cause))
  );
  return { success: true as const, data };
});

export const exchangeOAuthAccount = Effect.fn("accountAuth.exchangeOAuthAccount")(function* (
  userId: string,
  input: ExchangeOAuthInput
) {
  const config = OAUTH_PROVIDERS[input.provider];
  const parsed = parseOAuthCallbackUrl(input.callbackUrl, config.label);
  if (parsed instanceof ServiceFailure) return { success: false as const, error: parsed.message };
  const invalidContext = validateOAuthContext(config, input, parsed.state);
  if (invalidContext) return { success: false as const, error: invalidContext.message };

  const oauthResult = yield* config.exchangeCode(parsed.code, input.codeVerifier);
  const data = yield* upsertOAuthAccount(
    userId,
    input.provider,
    config.label,
    oauthResult,
    oauthAccountOptions(input.provider, config, oauthResult)
  );
  return { success: true as const, data };
}) as (
  userId: string,
  input: ExchangeOAuthInput
) => Effect.Effect<ActionResult<{ email: string; isUpdate: boolean }>, ServiceFailure>;

export const connectCodexSessionAccount = Effect.fn("accountAuth.connectCodexSessionAccount")(function* (
  userId: string,
  input: ConnectCodexSessionInput
) {
  const oauthResult = yield* Effect.try({
    try: () => buildOAuthResultFromChatGPTSession(input.sessionJson),
    catch: (cause) => badRequest(cause instanceof Error ? cause.message : "Failed to connect account"),
  });
  const data = yield* upsertOAuthAccount(
    userId,
    "codex",
    "Codex",
    oauthResult,
    oauthAccountOptions("codex", OAUTH_PROVIDERS.codex, oauthResult)
  );
  return { success: true as const, data };
}) as (
  userId: string,
  input: ConnectCodexSessionInput
) => Effect.Effect<ActionResult<{ email: string; isUpdate: boolean }>, ServiceFailure>;

export const initiateDeviceAuth = Effect.fn("accountAuth.initiateDeviceAuth")(function* (
  input: InitiateDeviceAuthInput
) {
  const config = DEVICE_PROVIDERS[input.provider];
  const data = yield* config.initiate().pipe(
    Effect.mapError((failure) => internal(failure.message, failure.cause))
  );
  return { success: true as const, data };
});

export const pollDeviceAuth = Effect.fn("accountAuth.pollDeviceAuth")(function* (
  userId: string,
  input: PollDeviceAuthInput
) {
  const config = DEVICE_PROVIDERS[input.provider];
  const result = yield* config.poll(input);
  if (result && typeof result === "object" && "pending" in result) {
    return {
      success: true as const,
      data: {
        status: "pending" as const,
        retryAfterSeconds:
          "retryAfterSeconds" in result ? (result.retryAfterSeconds as number | undefined) : undefined,
      },
    };
  }
  if (result && typeof result === "object" && "error" in result) {
    return { success: true as const, data: { status: "error" as const, message: String(result.error) } };
  }

  const oauthResult = result as OAuthResult;
  const provider = input.provider;
  const email = oauthResult.email || `${config.emailPrefix}-${Date.now()}`;
  const saved = yield* upsertOAuthAccount(
    userId,
    provider,
    config.label,
    oauthResult,
    provider === "codex" ? oauthAccountOptions(provider, OAUTH_PROVIDERS.codex, oauthResult) : { email }
  );
  return { success: true as const, data: { status: "success" as const, ...saved } };
});
