import { and, count as countFn, eq } from "drizzle-orm";
import { Effect } from "effect";

import type { CodexSessionInput, ExchangeInput, AuthUrlInput, DeviceAuthInput, DevicePollInput } from "@opendum/providers/contract";
import { db, providerAccount } from "@opendum/database";
import { publishAccounts } from "@opendum/api/web/events/bus";
import { encrypt } from "@opendum/api/web/lib/encryption";
import { antigravityProvider } from "@opendum/api/web/lib/providers/antigravity/index";
import { CLIENT_ID as antigravityClientId, REDIRECT_URI as antigravityRedirectUri, SCOPES as antigravityScopes } from "@opendum/api/web/lib/providers/antigravity/constants";
import { AUTHORIZE_ENDPOINT as codexAuthorizeEndpoint, BROWSER_REDIRECT_URI as codexBrowserRedirectUri, CLIENT_ID as codexClientId, ORIGINATOR as codexOriginator, SCOPE as codexScope, sessionResult, codexProvider, generateCodeChallenge as generateCodexCodeChallenge, codeVerifier as generateCodexCodeVerifier, startDeviceFlow as startCodexDevice, pollDeviceAuth as pollCodexDevice } from "@opendum/api/web/lib/providers/codex/index";
import { BROWSER_REDIRECT_URI as kiroBrowserRedirectUri, authUrl, codeVerifier as generateKiroCodeVerifier, kiroProvider } from "@opendum/api/web/lib/providers/kiro/index";
import { startDeviceFlow as startWorkbuddyDevice, pollDeviceAuth as pollWorkbuddyDevice } from "@opendum/api/web/lib/providers/workbuddy/index";
import { exchangeCode, initiateOAuth } from "@opendum/api/web/lib/providers/perch/index";
import { startDeviceFlow as startClineDevice, pollDeviceAuth as pollClineDevice } from "@opendum/api/web/lib/providers/cline/index";
import { clearFails } from "@opendum/api/web/lib/proxy/auth";
import { isFailed, isPending, type DeviceCodeFlow } from "@opendum/api/web/lib/providers/provider-response";
import type { OAuthResult } from "@opendum/api/web/lib/providers/types";
import type { DeviceProviderKey, AuthProvider } from "@opendum/providers/provider-accounts";
import type { ActionResult } from "@opendum/api/web/utils/api";
import { fromPromise } from "@opendum/api/web/lib/task";
import { ServiceFailure, badRequest, internal } from "@opendum/api/web/errors";
import { trackProviderEmail } from "@opendum/api/web/services/points";

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";

type ProviderAccountKey = AuthProvider | DeviceProviderKey;
type AuthUrlResult = { authUrl: string; state: string | null; codeVerifier: string | null };
type OAuthOptions = {
  email?: string;
  accountId?: string | null;
  dedupeByAccountId?: boolean;
};

const GOOGLE_OAUTH_CONFIG = {
  antigravity: { clientId: antigravityClientId, redirectUri: antigravityRedirectUri, scopes: antigravityScopes },
};

function oauthState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

function googleUrl(): string {
  const config = GOOGLE_OAUTH_CONFIG.antigravity;
  const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code", scope: config.scopes.join(" "), access_type: "offline", prompt: "consent" });
  return `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`;
}

const codexAuthUrl = Effect.fn("accountAuth.codexAuthUrl")(function* (state: string) {
  const codeVerifier = generateCodexCodeVerifier();
  const codeChallenge = yield* generateCodexCodeChallenge(codeVerifier);
  const params = new URLSearchParams({ response_type: "code", client_id: codexClientId, redirect_uri: codexBrowserRedirectUri, scope: codexScope, code_challenge: codeChallenge, code_challenge_method: "S256", id_token_add_organizations: "true", codex_cli_simplified_flow: "true", state, originator: codexOriginator });
  return { authUrl: `${codexAuthorizeEndpoint}?${params.toString()}`, state, codeVerifier };
});

const kiroAuthUrl = Effect.fn("accountAuth.kiroAuthUrl")(function* (state: string) {
  const codeVerifier = generateKiroCodeVerifier();
  return { authUrl: yield* authUrl(state, codeVerifier), state, codeVerifier };
});

const OAUTH_PROVIDERS: Record<AuthProvider, {
  label: string;
  accountIdPrefix?: string;
  requiresCodeVerifier?: boolean;
  buildAuthUrl: () => Effect.Effect<AuthUrlResult, ServiceFailure>;
  exchangeCode: (code: string, codeVerifier?: string | null) => Effect.Effect<OAuthResult, ServiceFailure>;
}> = {
  antigravity: {
    label: "Antigravity",
    buildAuthUrl: () => Effect.succeed({ authUrl: googleUrl(), state: null, codeVerifier: null }),
    exchangeCode: (code) => antigravityProvider.exchangeCode(code, antigravityRedirectUri),
  },
  codex: {
    label: "Codex",
    accountIdPrefix: "codex",
    requiresCodeVerifier: true,
    buildAuthUrl: () => codexAuthUrl(oauthState()),
    exchangeCode: (code, codeVerifier) => codexProvider.exchangeCode(code, codexBrowserRedirectUri, codeVerifier ?? undefined),
  },
  kiro: {
    label: "Kiro",
    accountIdPrefix: "kiro",
    requiresCodeVerifier: true,
    buildAuthUrl: () => kiroAuthUrl(oauthState()),
    exchangeCode: (code, codeVerifier) => kiroProvider.exchangeCode(code, kiroBrowserRedirectUri, codeVerifier ?? undefined),
  },
  perch: {
    label: "Perch",
    requiresCodeVerifier: true,
    buildAuthUrl: () =>
      initiateOAuth().pipe(
        Effect.map((result) => ({ authUrl: result.authUrl, state: null, codeVerifier: result.codeVerifier }))
      ),
    exchangeCode: (code, codeVerifier) => exchangeCode(code, codeVerifier ?? ""),
  },
};

type DeviceEntry = {
  label: string;
  emailPrefix: string;
  flow: DeviceCodeFlow;
};

function deviceEntry(
  label: string,
  emailPrefix: string,
  flow: DeviceCodeFlow
): DeviceEntry {
  return { label, emailPrefix, flow };
}

const DEVICE_PROVIDERS: Record<DeviceProviderKey, DeviceEntry> = {
  codex: deviceEntry("Codex", "codex", {
    startDeviceFlow: () => startCodexDevice(),
    pollDeviceAuth: (deviceCode, userCode) => pollCodexDevice(deviceCode, userCode),
  }),
  workbuddy: deviceEntry("WorkBuddy", "workbuddy", {
    startDeviceFlow: () => startWorkbuddyDevice(),
    pollDeviceAuth: (deviceCode) => pollWorkbuddyDevice(deviceCode),
  }),
  cline: deviceEntry("Cline", "cline", {
    startDeviceFlow: () => startClineDevice(),
    pollDeviceAuth: (deviceCode) => pollClineDevice(deviceCode),
  }),
};

function encryptRefresh(refreshToken: string | undefined): string {
  return refreshToken ? encrypt(refreshToken) : "";
}

function accountValues(oauthResult: OAuthResult, email: string, accountId: string | null) {
  return {
    accessToken: encrypt(oauthResult.accessToken),
    refreshToken: encryptRefresh(oauthResult.refreshToken),
    expiresAt: oauthResult.expiresAt,
    email,
    ...(oauthResult.projectId ? { projectId: oauthResult.projectId } : {}),
    ...(oauthResult.tier ? { tier: oauthResult.tier } : {}),
    ...(accountId ? { accountId } : {}),
    isActive: true,
    disabledUntil: null,
  };
}

type AccountFilter = { email: string } | { accountId: string };

function findAccount(userId: string, provider: ProviderAccountKey, filter: AccountFilter) {
  const match =
    "email" in filter
      ? eq(providerAccount.email, filter.email)
      : eq(providerAccount.accountId, filter.accountId);
  return fromPromise(
    () =>
      db
        .select({ id: providerAccount.id, email: providerAccount.email })
        .from(providerAccount)
        .where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, provider), match))
        .limit(1),
    "Failed to load provider account"
  );
}

const upsertAccount = Effect.fn("accountAuth.upsertAccount")(function* (
  userId: string,
  provider: ProviderAccountKey,
  label: string,
  oauthResult: OAuthResult,
  options: OAuthOptions = {}
) {
  const email = options.email || oauthResult.email || `${provider}-${Date.now()}`;
  const accountId = options.accountId ?? oauthResult.accountId ?? null;
  const foundByEmail = yield* findAccount(userId, provider, { email });
  const foundByAccount =
    !foundByEmail[0] && accountId && options.dedupeByAccountId
      ? yield* findAccount(userId, provider, { accountId })
      : [];
  const existingAccount = foundByEmail[0] ?? foundByAccount[0] ?? null;

  if (existingAccount) {
    const resolvedEmail =
      oauthResult.email && email === oauthResult.email
        ? oauthResult.email
        : existingAccount.email || email;
    yield* fromPromise(
      () =>
        db
          .update(providerAccount)
          .set(accountValues(oauthResult, resolvedEmail, accountId))
          .where(eq(providerAccount.id, existingAccount.id)),
      "Failed to update provider account"
    );
    yield* clearFails(existingAccount.id);
    yield* trackProviderEmail(userId, resolvedEmail);
    publishAccounts(userId);
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
        projectId: oauthResult.projectId,
        tier: oauthResult.tier,
        accountId,
        ...accountValues(oauthResult, email, accountId),
      }),
    "Failed to create provider account"
  );
  yield* trackProviderEmail(userId, email);
  publishAccounts(userId);
  return { email, isUpdate: false };
});

function optionsFor(provider: AuthProvider, config: (typeof OAUTH_PROVIDERS)[AuthProvider], oauthResult: OAuthResult): OAuthOptions | undefined {
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

function validateContext(config: (typeof OAUTH_PROVIDERS)[AuthProvider], input: ExchangeInput, parsedState: string | null): ServiceFailure | null {
  if (!config.requiresCodeVerifier) return null;
  if (parsedState !== input.state) return badRequest("Invalid OAuth state. Please restart authentication.");
  if (!input.codeVerifier) return badRequest("Missing authentication context. Please restart authentication.");
  return null;
}

function parseCallback(callbackUrl: string, providerLabel: string) {
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

export const authUrlFor = Effect.fn("accountAuth.getAuthUrl")(function* (input: AuthUrlInput) {
  const config = OAUTH_PROVIDERS[input.provider];
  const data = yield* config.buildAuthUrl().pipe(
    Effect.mapError((failure: { message?: string; cause?: unknown }) => internal(failure.message ?? "Account auth failed", failure.cause))
  );
  return { success: true as const, data };
});

export const exchangeAccount = Effect.fn("accountAuth.exchangeAccount")(function* (
  userId: string,
  input: ExchangeInput
) {
  const config = OAUTH_PROVIDERS[input.provider];
  const parsed = parseCallback(input.callbackUrl, config.label);
  if (parsed instanceof ServiceFailure) return { success: false as const, error: parsed.message };
  const invalidContext = validateContext(config, input, parsed.state);
  if (invalidContext) return { success: false as const, error: invalidContext.message };

  const oauthResult = yield* config.exchangeCode(parsed.code, input.codeVerifier);
  const data = yield* upsertAccount(
    userId,
    input.provider,
    config.label,
    oauthResult,
    optionsFor(input.provider, config, oauthResult)
  );
  return { success: true as const, data };
}) as (
  userId: string,
  input: ExchangeInput
) => Effect.Effect<ActionResult<{ email: string; isUpdate: boolean }>, ServiceFailure>;

export const connectCodex = Effect.fn("accountAuth.connectCodex")(function* (
  userId: string,
  input: CodexSessionInput
) {
  const oauthResult = yield* Effect.try({
    try: () => sessionResult(input.sessionJson),
    catch: (cause) => badRequest(cause instanceof Error ? cause.message : "Failed to connect account"),
  });
  const data = yield* upsertAccount(
    userId,
    "codex",
    "Codex",
    oauthResult,
    optionsFor("codex", OAUTH_PROVIDERS.codex, oauthResult)
  );
  return { success: true as const, data };
}) as (
  userId: string,
  input: CodexSessionInput
) => Effect.Effect<ActionResult<{ email: string; isUpdate: boolean }>, ServiceFailure>;

export const initiateDeviceAuth = Effect.fn("accountAuth.initiateDeviceAuth")(function* (
  input: DeviceAuthInput
) {
  const config = DEVICE_PROVIDERS[input.provider];
  const data = yield* config.flow.startDeviceFlow().pipe(
    Effect.mapError((failure) => internal(failure.message || "Account auth failed", failure.cause))
  );
  return { success: true as const, data };
});

export const pollAuth = Effect.fn("accountAuth.pollAuth")(function* (
  userId: string,
  input: DevicePollInput
) {
  const config = DEVICE_PROVIDERS[input.provider];
  const result = yield* config.flow.pollDeviceAuth(input.deviceCode, input.userCode ?? "");
  if (isPending(result)) {
    return {
      success: true as const,
      data: { status: "pending" as const, retryAfterSeconds: result.retryAfterSeconds },
    };
  }
  if (isFailed(result)) {
    return { success: true as const, data: { status: "error" as const, message: result.error } };
  }

  const oauthResult = result;
  const provider = input.provider;
  const email = oauthResult.email || `${config.emailPrefix}-${Date.now()}`;
  const saved = yield* upsertAccount(
    userId,
    provider,
    config.label,
    oauthResult,
    provider === "codex" ? optionsFor(provider, OAUTH_PROVIDERS.codex, oauthResult) : { email }
  );
  return { success: true as const, data: { status: "success" as const, ...saved } };
});
