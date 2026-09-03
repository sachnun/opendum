import { fetchInternalProvider } from "../../proxy/internal-relay.js";
import { formatProviderHttpError } from "../provider-http-errors.js";
import type { OAuthResult } from "../types.js";
import {
  PERCH_ACCOUNT_PATH,
  PERCH_APP_URL,
  PERCH_AUTH_CONFIG_PATH,
  PERCH_AUTH_TOKEN_PATH,
  PERCH_REDIRECT_URI,
  PERCH_STARTER_PLAN_CODE,
} from "./constants.js";

interface PerchAuthConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  providers?: string[];
  ok?: boolean;
}

interface PerchTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  expires_in?: number;
  user?: { email?: string | null; id?: string };
}

interface PerchAccountSession {
  userId?: string;
  workspaceId?: string;
  planCode?: string;
  planName?: string;
  tierSelectionRequired?: boolean;
}

interface PerchAccountResponse {
  ok?: boolean;
  session?: PerchAccountSession;
}

function formatPerchError(response: Response, body: string, endpointLabel: string): string {
  return formatProviderHttpError("Perch", response, body, { endpointLabel });
}

async function fetchPerchAuthConfig(): Promise<PerchAuthConfig> {
  const response = await fetchInternalProvider(`${PERCH_APP_URL}${PERCH_AUTH_CONFIG_PATH}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(formatPerchError(response, body, "auth config endpoint"));
  }
  const config = (await response.json().catch(() => ({}))) as PerchAuthConfig;
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    throw new Error("Perch auth config is incomplete. Please try again later.");
  }
  return config;
}

function perchProviderId(config: PerchAuthConfig): string {
  const enabled = (config.providers ?? []).filter((provider) => provider === "google" || provider === "github");
  if (enabled.length === 0) throw new Error("No supported Perch OAuth provider is enabled right now.");
  if (enabled.includes("google")) return "google";
  return "github";
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64UrlEncode(verifierBytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function perchSupabaseUrl(config: PerchAuthConfig): string {
  return config.supabaseUrl.replace(/\/+$/, "");
}

function perchAuthHeaders(config: PerchAuthConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    apikey: config.supabaseAnonKey,
    Authorization: `Bearer ${config.supabaseAnonKey}`,
    Accept: "application/json",
  };
}

export interface PerchInitiateResult {
  authUrl: string;
  codeVerifier: string;
  verificationUrl: string;
}

export async function initiatePerchOAuth(): Promise<PerchInitiateResult> {
  const config = await fetchPerchAuthConfig();
  const { verifier, challenge } = await pkcePair();
  const params = new URLSearchParams({
    provider: perchProviderId(config),
    code_challenge: challenge,
    code_challenge_method: "s256",
    redirect_to: PERCH_REDIRECT_URI,
  });
  const authUrl = `${perchSupabaseUrl(config)}/auth/v1/authorize?${params.toString()}`;
  return { authUrl, codeVerifier: verifier, verificationUrl: authUrl };
}

async function selectPerchStarterPlan(config: PerchAuthConfig, accessToken: string): Promise<void> {
  const response = await fetchInternalProvider(`${perchSupabaseUrl(config)}/rest/v1/rpc/perch_ai_select_plan`, {
    method: "POST",
    headers: { ...perchAuthHeaders(config), Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ p_plan_code: PERCH_STARTER_PLAN_CODE }),
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; reason?: string };
  if (!response.ok || payload.ok === false) {
    throw new Error(
      payload.error === "banned"
        ? `Perch sign-in blocked: ${payload.reason ?? "account banned"}. Contact hello@perchai.app.`
        : "Could not select the Perch Starter plan. Pick a plan at https://chat.perchai.app/perchai."
    );
  }
}

async function ensurePerchSessionReady(accessToken: string): Promise<void> {
  const accountResponse = await fetchInternalProvider(`${PERCH_APP_URL}${PERCH_ACCOUNT_PATH}`, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!accountResponse.ok) return;
  const account = (await accountResponse.json().catch(() => ({}))) as PerchAccountResponse;
  if (account.ok !== true || !account.session?.tierSelectionRequired) return;
  const config = await fetchPerchAuthConfig();
  await selectPerchStarterPlan(config, accessToken);
}

export async function exchangePerchOAuthCode(code: string, codeVerifier: string): Promise<OAuthResult> {
  const config = await fetchPerchAuthConfig();
  const response = await fetchInternalProvider(`${perchSupabaseUrl(config)}${PERCH_AUTH_TOKEN_PATH}?grant_type=pkce`, {
    method: "POST",
    headers: perchAuthHeaders(config),
    body: JSON.stringify({ auth_code: code, code_verifier: codeVerifier }),
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(formatPerchError(response, body, "token exchange endpoint"));
  }
  const tokens = (await response.json().catch(() => ({}))) as PerchTokenResponse;
  if (!tokens.access_token) {
    throw new Error("Perch token exchange returned an incomplete session.");
  }
  await ensurePerchSessionReady(tokens.access_token);
  const expiresAt = typeof tokens.expires_at === "number" && tokens.expires_at > 0
    ? new Date(tokens.expires_at * 1000)
    : new Date(Date.now() + (typeof tokens.expires_in === "number" && tokens.expires_in > 0 ? tokens.expires_in : 3600) * 1000);
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? "",
    expiresAt,
    email: tokens.user?.email ?? "",
  };
}
