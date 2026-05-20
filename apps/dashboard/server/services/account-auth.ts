import { and, count as countFn, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { providerAccount } from "../lib/db/schema";
import { encrypt } from "../lib/encryption";
import { antigravityProvider } from "../lib/providers/antigravity";
import { CLIENT_ID as antigravityClientId, REDIRECT_URI as antigravityRedirectUri, SCOPES as antigravityScopes } from "../lib/providers/antigravity/constants";
import { initiateCopilotDeviceCodeFlow, pollCopilotDeviceCodeAuthorization } from "../lib/providers/copilot";
import { AUTHORIZE_ENDPOINT as codexAuthorizeEndpoint, BROWSER_REDIRECT_URI as codexBrowserRedirectUri, CLIENT_ID as codexClientId, ORIGINATOR as codexOriginator, SCOPE as codexScope, buildOAuthResultFromChatGPTSession, codexProvider, generateCodeChallenge as generateCodexCodeChallenge, generateCodeVerifier as generateCodexCodeVerifier, initiateCodexDeviceCodeFlow, pollCodexDeviceCodeAuthorization } from "../lib/providers/codex";
import { geminiCliProvider } from "../lib/providers/gemini-cli";
import { CLIENT_ID as geminiCliClientId, REDIRECT_URI as geminiCliRedirectUri, SCOPES as geminiCliScopes } from "../lib/providers/gemini-cli/constants";
import { BROWSER_REDIRECT_URI as kiroBrowserRedirectUri, buildKiroAuthUrl, generateCodeVerifier as generateKiroCodeVerifier, kiroProvider } from "../lib/providers/kiro";
import { initiateDeviceCodeFlow, pollDeviceCodeAuthorization } from "../lib/providers/qwen-code";
import type { OAuthResult } from "../lib/providers/types";
import type { ActionResult } from "../utils/api";

const GOOGLE_OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export const getAuthUrlInputSchema = z.object({ provider: z.enum(["antigravity", "gemini_cli", "codex", "kiro"]) });
export const exchangeOAuthInputSchema = z.object({ provider: z.enum(["antigravity", "gemini_cli", "codex", "kiro"]), callbackUrl: z.string(), state: z.string().nullable().optional(), codeVerifier: z.string().nullable().optional() });
const copilotAuthMethodSchema = z.enum(["opencode", "official"]).optional();
export const initiateDeviceAuthInputSchema = z.object({ provider: z.enum(["qwen_code", "copilot", "codex"]), method: copilotAuthMethodSchema });
export const pollDeviceAuthInputSchema = z.object({ provider: z.enum(["qwen_code", "copilot", "codex"]), deviceCode: z.string(), userCode: z.string().optional(), codeVerifier: z.string().optional(), method: copilotAuthMethodSchema });
export const connectCodexSessionInputSchema = z.object({ sessionJson: z.string().min(1, "Session JSON is required") });

type OAuthProviderKey = z.infer<typeof getAuthUrlInputSchema>["provider"];
type DeviceProviderKey = z.infer<typeof initiateDeviceAuthInputSchema>["provider"];
type ProviderAccountKey = OAuthProviderKey | DeviceProviderKey;
type AuthUrlResult = { authUrl: string; state: string | null; codeVerifier: string | null };
type OAuthAccountOptions = {
  email?: string;
  accountId?: string | null;
  dedupeByAccountId?: boolean;
};

const GOOGLE_OAUTH_CONFIG = {
  antigravity: { clientId: antigravityClientId, redirectUri: antigravityRedirectUri, scopes: antigravityScopes },
  gemini_cli: { clientId: geminiCliClientId, redirectUri: geminiCliRedirectUri, scopes: geminiCliScopes },
};

function generateOAuthState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

function buildGoogleOAuthUrl(provider: "antigravity" | "gemini_cli"): string {
  const config = GOOGLE_OAUTH_CONFIG[provider];
  const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code", scope: config.scopes.join(" "), access_type: "offline", prompt: "consent" });
  return `${GOOGLE_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

async function buildCodexOAuthUrl(state: string) {
  const codeVerifier = generateCodexCodeVerifier();
  const codeChallenge = await generateCodexCodeChallenge(codeVerifier);
  const params = new URLSearchParams({ response_type: "code", client_id: codexClientId, redirect_uri: codexBrowserRedirectUri, scope: codexScope, code_challenge: codeChallenge, code_challenge_method: "S256", id_token_add_organizations: "true", codex_cli_simplified_flow: "true", state, originator: codexOriginator });
  return { authUrl: `${codexAuthorizeEndpoint}?${params.toString()}`, state, codeVerifier };
}

async function buildKiroOAuthUrl(state: string) {
  const codeVerifier = generateKiroCodeVerifier();
  return { authUrl: await buildKiroAuthUrl(state, codeVerifier), state, codeVerifier };
}

const OAUTH_PROVIDERS: Record<OAuthProviderKey, {
  label: string;
  accountIdPrefix?: string;
  requiresCodeVerifier?: boolean;
  buildAuthUrl: () => Promise<AuthUrlResult>;
  exchangeCode: (code: string, codeVerifier?: string | null) => Promise<OAuthResult>;
}> = {
  antigravity: {
    label: "Antigravity",
    buildAuthUrl: async () => ({ authUrl: buildGoogleOAuthUrl("antigravity"), state: null, codeVerifier: null }),
    exchangeCode: (code) => antigravityProvider.exchangeCode(code, antigravityRedirectUri),
  },
  gemini_cli: {
    label: "Gemini CLI",
    buildAuthUrl: async () => ({ authUrl: buildGoogleOAuthUrl("gemini_cli"), state: null, codeVerifier: null }),
    exchangeCode: (code) => geminiCliProvider.exchangeCode(code, geminiCliRedirectUri),
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
};

const DEVICE_PROVIDERS = {
  copilot: {
    label: "Copilot",
    emailPrefix: "copilot",
    initiate: (input: z.infer<typeof initiateDeviceAuthInputSchema>) => initiateCopilotDeviceCodeFlow(input.method),
    poll: (input: z.infer<typeof pollDeviceAuthInputSchema>) => pollCopilotDeviceCodeAuthorization(input.deviceCode, input.method),
  },
  qwen_code: {
    label: "Qwen Code",
    emailPrefix: "qwen",
    initiate: initiateDeviceCodeFlow,
    poll: (input: z.infer<typeof pollDeviceAuthInputSchema>) => pollDeviceCodeAuthorization(input.deviceCode, input.codeVerifier ?? ""),
  },
  codex: {
    label: "Codex",
    emailPrefix: "codex",
    initiate: initiateCodexDeviceCodeFlow,
    poll: (input: z.infer<typeof pollDeviceAuthInputSchema>) => pollCodexDeviceCodeAuthorization(input.deviceCode, input.userCode ?? ""),
  },
} satisfies Record<DeviceProviderKey, { label: string; emailPrefix: string; initiate: (input: z.infer<typeof initiateDeviceAuthInputSchema>) => Promise<unknown>; poll: (input: z.infer<typeof pollDeviceAuthInputSchema>) => Promise<unknown> }>;

function parseOAuthCallbackUrl(callbackUrl: string, providerLabel: string): ActionResult<{ code: string; state: string | null }> {
  if (!callbackUrl || typeof callbackUrl !== "string") return { success: false, error: "Callback URL is required" };

  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    return { success: false, error: "Invalid URL format" };
  }

  const error = url.searchParams.get("error");
  if (error) return { success: false, error: `${providerLabel} OAuth error: ${url.searchParams.get("error_description") || error}` };

  const code = url.searchParams.get("code");
  if (!code) return { success: false, error: "No authorization code found in URL. Make sure you copied the complete URL from your browser." };
  return { success: true, data: { code, state: url.searchParams.get("state") } };
}

function encryptOptionalRefreshToken(refreshToken: string | undefined): string {
  return refreshToken ? encrypt(refreshToken) : "";
}

async function upsertOAuthAccount(userId: string, provider: ProviderAccountKey, label: string, oauthResult: OAuthResult, options: OAuthAccountOptions = {}): Promise<ActionResult<{ email: string; isUpdate: boolean }>> {
  const email = options.email || oauthResult.email || `${provider}-${Date.now()}`;
  const accountId = options.accountId ?? oauthResult.accountId ?? null;
  const [foundByEmail] = await db.select({ id: providerAccount.id, email: providerAccount.email }).from(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, provider), eq(providerAccount.email, email))).limit(1);
  const [foundByAccountId] = !foundByEmail && accountId && options.dedupeByAccountId
    ? await db.select({ id: providerAccount.id, email: providerAccount.email }).from(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, provider), eq(providerAccount.accountId, accountId))).limit(1)
    : [];
  const existingAccount = foundByEmail ?? foundByAccountId ?? null;

  if (existingAccount) {
    const resolvedEmail = oauthResult.email && email === oauthResult.email ? oauthResult.email : existingAccount.email || email;
    await db.update(providerAccount).set({ accessToken: encrypt(oauthResult.accessToken), refreshToken: encryptOptionalRefreshToken(oauthResult.refreshToken), expiresAt: oauthResult.expiresAt, email: resolvedEmail, ...(oauthResult.projectId ? { projectId: oauthResult.projectId } : {}), ...(oauthResult.tier ? { tier: oauthResult.tier } : {}), ...(accountId ? { accountId } : {}), isActive: true, disabledUntil: null }).where(eq(providerAccount.id, existingAccount.id));
    return { success: true, data: { email: resolvedEmail, isUpdate: true } };
  }

  const [countResult] = await db.select({ value: countFn() }).from(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, provider)));
  await db.insert(providerAccount).values({ userId, provider, name: `${label} ${(countResult?.value ?? 0) + 1}`, accessToken: encrypt(oauthResult.accessToken), refreshToken: encryptOptionalRefreshToken(oauthResult.refreshToken), expiresAt: oauthResult.expiresAt, email, projectId: oauthResult.projectId, tier: oauthResult.tier, accountId, isActive: true });
  return { success: true, data: { email, isUpdate: false } };
}

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

function validateOAuthContext(config: (typeof OAUTH_PROVIDERS)[OAuthProviderKey], input: z.infer<typeof exchangeOAuthInputSchema>, parsedState: string | null): ActionResult<void> | null {
  if (!config.requiresCodeVerifier) return null;
  if (parsedState !== input.state) return { success: false, error: "Invalid OAuth state. Please restart authentication." };
  if (!input.codeVerifier) return { success: false, error: "Missing authentication context. Please restart authentication." };
  return null;
}

export async function getAccountAuthUrl(input: z.infer<typeof getAuthUrlInputSchema>) {
  try {
    return { success: true, data: await OAUTH_PROVIDERS[input.provider].buildAuthUrl() } as const;
  } catch (error) {
    console.error("Failed to build provider auth URL:", error);
    return { success: false, error: error instanceof Error ? error.message : "Failed to build login URL" } as const;
  }
}

export async function exchangeOAuthAccount(userId: string, input: z.infer<typeof exchangeOAuthInputSchema>) {
  try {
    const config = OAUTH_PROVIDERS[input.provider];
    const parsedUrl = parseOAuthCallbackUrl(input.callbackUrl, config.label);
    if (!parsedUrl.success) return parsedUrl;
    const invalidContext = validateOAuthContext(config, input, parsedUrl.data.state);
    if (invalidContext) return invalidContext;

    const oauthResult = await config.exchangeCode(parsedUrl.data.code, input.codeVerifier);
    return await upsertOAuthAccount(userId, input.provider, config.label, oauthResult, oauthAccountOptions(input.provider, config, oauthResult));
  } catch (error) {
    console.error("Failed to exchange provider OAuth code:", error);
    return { success: false, error: error instanceof Error ? error.message : "Failed to connect account" } as const;
  }
}

export async function connectCodexSessionAccount(userId: string, input: z.infer<typeof connectCodexSessionInputSchema>) {
  try {
    const oauthResult = buildOAuthResultFromChatGPTSession(input.sessionJson);
    return await upsertOAuthAccount(userId, "codex", "Codex", oauthResult, oauthAccountOptions("codex", OAUTH_PROVIDERS.codex, oauthResult));
  } catch (error) {
    console.error("Failed to connect Codex ChatGPT session:", error);
    return { success: false, error: error instanceof Error ? error.message : "Failed to connect account" } as const;
  }
}

export async function initiateDeviceAuth(input: z.infer<typeof initiateDeviceAuthInputSchema>) {
  try {
    const result = await DEVICE_PROVIDERS[input.provider].initiate(input);
    return { success: true, data: result } as const;
  } catch (error) {
    console.error("Failed to initiate provider device auth:", error);
    return { success: false, error: error instanceof Error ? error.message : "Failed to start device login" } as const;
  }
}

export async function pollDeviceAuth(userId: string, input: z.infer<typeof pollDeviceAuthInputSchema>) {
  try {
    const config = DEVICE_PROVIDERS[input.provider];
    const result = await config.poll(input);
    if ("pending" in result) return { success: true, data: { status: "pending" as const, retryAfterSeconds: "retryAfterSeconds" in result ? result.retryAfterSeconds : undefined } } as const;
    if ("error" in result) return { success: true, data: { status: "error" as const, message: result.error } } as const;

    const provider = input.provider;
    const email = result.email || `${config.emailPrefix}-${Date.now()}`;
    const saved = await upsertOAuthAccount(userId, provider, config.label, result, provider === "codex" ? oauthAccountOptions(provider, OAUTH_PROVIDERS.codex, result) : { email });
    if (!saved.success) return saved;
    return { success: true, data: { status: "success" as const, ...saved.data } } as const;
  } catch (error) {
    console.error("Failed to poll provider device auth:", error);
    return { success: false, error: error instanceof Error ? error.message : "Failed to connect account" } as const;
  }
}
