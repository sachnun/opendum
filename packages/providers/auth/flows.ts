import { Effect } from "effect";

import { antigravityAuth } from "@opendum/providers/auth/antigravity/index";
import {
  CLIENT_ID as antigravityClientId,
  REDIRECT_URI as antigravityRedirectUri,
  SCOPES as antigravityScopes,
} from "@opendum/providers/auth/antigravity/constants";
import { codexAuth } from "@opendum/providers/auth/codex/index";
import { kiroAuth } from "@opendum/providers/auth/kiro/index";
import { workbuddyAuth } from "@opendum/providers/auth/workbuddy/index";
import { perchAuth } from "@opendum/providers/auth/perch/index";
import { clineAuth } from "@opendum/providers/auth/cline/index";
import { badRequest, type AuthFailure } from "@opendum/providers/auth/failure";
import { Pkce } from "@opendum/providers/auth/pkce";
import type { DeviceCodeFlow } from "@opendum/providers/auth/response";
import type { OAuthResult } from "@opendum/providers/auth/result";
import type { AuthRuntime } from "@opendum/providers/auth/runtime";
import type { AuthProvider, DeviceProviderKey } from "@opendum/providers/provider-accounts";

export type AuthUrlResult = {
  authUrl: string;
  state: string | null;
  codeVerifier: string | null;
};

export type OAuthOptions = {
  email?: string;
  accountId?: string | null;
  dedupeByAccountId?: boolean;
};

export type OAuthEntry = {
  label: string;
  accountIdPrefix?: string;
  requiresCodeVerifier?: boolean;
  buildAuthUrl: () => Effect.Effect<AuthUrlResult, AuthFailure | Error>;
  exchangeCode: (code: string, codeVerifier?: string | null) => Effect.Effect<OAuthResult, AuthFailure | Error>;
};

export type DeviceEntry = {
  label: string;
  emailPrefix: string;
  flow: DeviceCodeFlow;
};

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";

function oauthState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

function authorizeUrl(endpoint: string, params: Record<string, string>): string {
  return `${endpoint}?${new URLSearchParams(params).toString()}`;
}

function pkceUrl(endpoint: string, verifier: string, label: string, params: Record<string, string>) {
  return Pkce.challenge(verifier, label).pipe(
    Effect.map((challenge) => ({
      authUrl: authorizeUrl(endpoint, {
        ...params,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
      state: params.state ?? null,
      codeVerifier: verifier,
    }))
  );
}

export function oauthFlows(runtime: AuthRuntime): Record<AuthProvider, OAuthEntry> {
  const antigravity = antigravityAuth(runtime);
  const codex = codexAuth(runtime);
  const kiro = kiroAuth(runtime);
  const perch = perchAuth(runtime);

  const googleUrl = () =>
    authorizeUrl(GOOGLE_AUTHORIZE_URL, {
      client_id: antigravityClientId,
      redirect_uri: antigravityRedirectUri,
      response_type: "code",
      scope: antigravityScopes.join(" "),
      access_type: "offline",
      prompt: "consent",
    });

  return {
    antigravity: {
      label: "Antigravity",
      buildAuthUrl: () => Effect.succeed({ authUrl: googleUrl(), state: null, codeVerifier: null }),
      exchangeCode: (code) => antigravity.antigravityProvider.exchangeCode(code, antigravityRedirectUri),
    },
    codex: {
      label: "Codex",
      accountIdPrefix: "codex",
      requiresCodeVerifier: true,
      buildAuthUrl: () =>
        codex.authUrl(oauthState()).pipe(
          Effect.map((result) => ({ authUrl: result.authUrl, state: result.state, codeVerifier: result.codeVerifier }))
        ),
      exchangeCode: (code, verifier) => codex.codexProvider.exchangeCode(code, verifier ?? ""),
    },
    kiro: {
      label: "Kiro",
      accountIdPrefix: "kiro",
      requiresCodeVerifier: true,
      buildAuthUrl: () => pkceUrl(kiro.AUTHORIZE_ENDPOINT, kiro.codeVerifier(), "Kiro", kiro.authParams(oauthState())),
      exchangeCode: (code, verifier) => kiro.kiroProvider.exchangeCode(code, verifier ?? ""),
    },
    perch: {
      label: "Perch",
      requiresCodeVerifier: true,
      buildAuthUrl: () =>
        perch
          .initiateOAuth()
          .pipe(Effect.map((r) => ({ authUrl: r.authUrl, state: null, codeVerifier: r.codeVerifier }))),
      exchangeCode: (code, verifier) => perch.exchangeCode(code, verifier ?? ""),
    },
  };
}

export function deviceFlows(runtime: AuthRuntime): Record<DeviceProviderKey, DeviceEntry> {
  const codex = codexAuth(runtime);
  const workbuddy = workbuddyAuth(runtime);
  const cline = clineAuth(runtime);

  return {
    codex: {
      label: "Codex",
      emailPrefix: "codex",
      flow: {
        startDeviceFlow: () => codex.startDeviceFlow(),
        pollDeviceAuth: (deviceCode, userCode) => codex.pollDeviceAuth(deviceCode, userCode),
      },
    },
    workbuddy: {
      label: "WorkBuddy",
      emailPrefix: "workbuddy",
      flow: {
        startDeviceFlow: () => workbuddy.startDeviceFlow(),
        pollDeviceAuth: (deviceCode) => workbuddy.pollDeviceAuth(deviceCode),
      },
    },
    cline: {
      label: "Cline",
      emailPrefix: "cline",
      flow: {
        startDeviceFlow: () => cline.startDeviceFlow(),
        pollDeviceAuth: (deviceCode) => cline.pollDeviceAuth(deviceCode),
      },
    },
  };
}

export function optionsFor(
  provider: AuthProvider,
  config: OAuthEntry,
  oauthResult: OAuthResult
): OAuthOptions | undefined {
  if (provider === "codex") {
    const chatgptAccountId = oauthResult.accountId || null;
    const workspaceAccountId = oauthResult.workspaceId || chatgptAccountId || null;
    const isPersonal = !workspaceAccountId || workspaceAccountId === chatgptAccountId;
    return {
      email:
        oauthResult.email && isPersonal
          ? oauthResult.email
          : workspaceAccountId
            ? `codex-${workspaceAccountId}`
            : `codex-${Date.now()}`,
      accountId: chatgptAccountId,
      dedupeByAccountId: isPersonal,
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
  return {
    email: accountId ? `${config.accountIdPrefix}-${accountId}` : `${config.accountIdPrefix}-${Date.now()}`,
    accountId,
    dedupeByAccountId: true,
  };
}

export function validateContext(
  config: OAuthEntry,
  input: { state?: string | null; codeVerifier?: string | null },
  parsedState: string | null
): AuthFailure | null {
  if (!config.requiresCodeVerifier) return null;
  if (parsedState !== input.state) return badRequest("Invalid OAuth state. Please restart authentication.");
  if (!input.codeVerifier) return badRequest("Missing authentication context. Please restart authentication.");
  return null;
}

export function parseCallback(callbackUrl: string, providerLabel: string) {
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
