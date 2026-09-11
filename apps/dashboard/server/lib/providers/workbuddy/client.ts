import { fetchInternalProvider } from "../../proxy/internal-relay.js";
import { formatProviderHttpError } from "../provider-http-errors.js";
import type { OAuthResult } from "../types.js";
import {
  ACCOUNTS_PATH,
  AUTH_REFRESH_SOURCE,
  AUTH_STATE_PATH,
  AUTH_TOKEN_PATH,
  AUTH_TOKEN_REFRESH_PATH,
  DEVICE_CODE_EXPIRY_SECONDS,
  LOGIN_ACCOUNT_PATH,
  PENDING_ACCOUNT_CODE,
  PENDING_TOKEN_CODE,
  POLLING_INTERVAL_SECONDS,
  WORKBUDDY_BASE_URL,
  WORKBUDDY_DOMAIN,
  WORKBUDDY_PLATFORM,
} from "./constants.js";

interface WorkbuddyStateResponse {
  code?: number;
  msg?: string;
  data?: {
    state?: string;
    authUrl?: string;
  };
}

interface WorkbuddyTokenData {
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  expiresAt?: number;
  refreshExpiresIn?: number;
  refreshExpiresAt?: number;
}

interface WorkbuddyTokenResponse {
  code?: number;
  msg?: string;
  data?: WorkbuddyTokenData;
}

interface WorkbuddyAccount {
  uid?: string;
  email?: string;
  mail?: string;
  preferred_username?: string;
  username?: string;
  nickname?: string;
  name?: string;
}

interface WorkbuddyAccountResponse {
  code?: number;
  msg?: string;
  data?: WorkbuddyAccount | { account?: WorkbuddyAccount; accounts?: WorkbuddyAccount[] };
}

interface WorkbuddyAccountsResponse {
  code?: number;
  msg?: string;
  data?: { accounts?: WorkbuddyAccount[]; account?: WorkbuddyAccount };
}

export interface WorkbuddyInitiateResult {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete: string;
  expiresIn: number;
  interval: number;
}

function calculateExpiresAt(data: WorkbuddyTokenData, fallbackSeconds: number): Date {
  if (typeof data.expiresAt === "number" && data.expiresAt > 0) {
    return new Date(data.expiresAt > 10_000_000_000 ? data.expiresAt : data.expiresAt * 1000);
  }
  const expiresIn = typeof data.expiresIn === "number" && data.expiresIn > 0 ? data.expiresIn : fallbackSeconds;
  return new Date(Date.now() + expiresIn * 1000);
}

function accountEmail(account: WorkbuddyAccount): string {
  const candidates = [account.email, account.mail, account.preferred_username, account.username, account.nickname, account.name];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function accountUid(account: WorkbuddyAccount): string {
  return typeof account.uid === "string" ? account.uid.trim() : "";
}

function firstAccount(value: WorkbuddyAccountResponse["data"]): WorkbuddyAccount | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray((value as { accounts?: unknown }).accounts)) {
    const accounts = (value as { accounts?: WorkbuddyAccount[] }).accounts ?? [];
    return accounts.find((entry) => entry && typeof entry === "object") ?? null;
  }
  if ((value as { account?: WorkbuddyAccount }).account && typeof (value as { account?: WorkbuddyAccount }).account === "object") {
    return (value as { account?: WorkbuddyAccount }).account ?? null;
  }
  return value as WorkbuddyAccount;
}

export async function initiateWorkbuddyDeviceCodeFlow(): Promise<WorkbuddyInitiateResult> {
  const url = `${WORKBUDDY_BASE_URL}${AUTH_STATE_PATH}?platform=${encodeURIComponent(WORKBUDDY_PLATFORM)}`;
  const response = await fetchInternalProvider(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({}),
    cache: "no-store",
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(formatProviderHttpError("WorkBuddy", response, body, { endpointLabel: "auth state endpoint" }));
  }

  const data = (await response.json().catch(() => ({}))) as WorkbuddyStateResponse;
  const state = data.data?.state?.trim() ?? "";
  const authUrl = data.data?.authUrl?.trim() ?? "";
  if (!state || !authUrl) throw new Error("WorkBuddy auth state response is missing required fields");

  return {
    deviceCode: state,
    userCode: "",
    verificationUrl: authUrl,
    verificationUrlComplete: authUrl,
    expiresIn: DEVICE_CODE_EXPIRY_SECONDS,
    interval: POLLING_INTERVAL_SECONDS,
  };
}

export async function pollWorkbuddyDeviceCodeAuthorization(
  deviceCode: string
): Promise<OAuthResult | { pending: true; retryAfterSeconds?: number } | { error: string }> {
  const state = deviceCode.trim();
  if (!state) return { error: "WorkBuddy device code is missing. Please try again." };

  const url = `${WORKBUDDY_BASE_URL}${AUTH_TOKEN_PATH}?state=${encodeURIComponent(state)}`;
  const response = await fetchInternalProvider(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return {
      error: formatProviderHttpError("WorkBuddy", response, body, { endpointLabel: "device token polling endpoint" }),
    };
  }

  const data = (await response.json().catch(() => ({}))) as WorkbuddyTokenResponse;
  if (data.code === PENDING_TOKEN_CODE) return { pending: true };
  if (data.code !== 0 || !data.data) {
    if (!data.data) return { pending: true };
    const detail = typeof data.msg === "string" && data.msg ? `: ${data.msg}` : "";
    return { error: `WorkBuddy authorization failed (${data.code ?? "unknown"}${detail}). Please try again.` };
  }

  const accessToken = data.data.accessToken?.trim() ?? "";
  if (!accessToken) return { pending: true };

  const identity = await fetchWorkbuddyIdentity(accessToken, state);
  if (!identity) return { pending: true };

  return {
    accessToken,
    refreshToken: data.data.refreshToken?.trim() || accessToken,
    expiresAt: calculateExpiresAt(data.data, 31536000),
    email: identity.email,
    accountId: identity.uid,
  };
}

async function fetchWorkbuddyIdentity(accessToken: string, state: string): Promise<{ uid: string; email: string } | null> {
  const baseHeaders = { Authorization: `Bearer ${accessToken}`, "X-Domain": WORKBUDDY_DOMAIN, Accept: "application/json" };

  try {
    const loginResponse = await fetchInternalProvider(
      `${WORKBUDDY_BASE_URL}${LOGIN_ACCOUNT_PATH}?state=${encodeURIComponent(state)}`,
      { method: "GET", headers: baseHeaders, cache: "no-store" }
    );
    if (loginResponse.ok) {
      const loginData = (await loginResponse.json().catch(() => ({}))) as WorkbuddyAccountResponse;
      if (loginData.code !== PENDING_ACCOUNT_CODE) {
        const account = firstAccount(loginData.data);
        if (account && accountUid(account)) {
          const withAccounts = await fetchWorkbuddyAccounts(accessToken, accountUid(account));
          const resolved = withAccounts ?? account;
          return { uid: accountUid(resolved), email: accountEmail(resolved) };
        }
      }
    }
  } catch {
    // Fall through to the accounts snapshot.
  }

  const fallback = await fetchWorkbuddyAccounts(accessToken, "");
  if (fallback && accountUid(fallback)) return { uid: accountUid(fallback), email: accountEmail(fallback) };
  return null;
}

async function fetchWorkbuddyAccounts(accessToken: string, uid: string): Promise<WorkbuddyAccount | null> {
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "X-Domain": WORKBUDDY_DOMAIN,
      Accept: "application/json",
    };
    if (uid) headers["X-User-Id"] = uid;
    const response = await fetchInternalProvider(`${WORKBUDDY_BASE_URL}${ACCOUNTS_PATH}`, {
      method: "GET",
      headers,
      cache: "no-store",
    });
    if (!response.ok) return null;
    const data = (await response.json().catch(() => ({}))) as WorkbuddyAccountsResponse;
    if (data.code !== 0 || !data.data) return null;
    const accounts = data.data.accounts ?? (data.data.account ? [data.data.account] : []);
    return accounts.find((entry) => entry && accountUid(entry)) ?? null;
  } catch {
    return null;
  }
}

export async function refreshWorkbuddyToken(accessToken: string, refreshToken: string): Promise<OAuthResult> {
  const response = await fetchInternalProvider(`${WORKBUDDY_BASE_URL}${AUTH_TOKEN_REFRESH_PATH}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-Refresh-Token": refreshToken,
      "X-Auth-Refresh-Source": AUTH_REFRESH_SOURCE,
      "X-Domain": WORKBUDDY_DOMAIN,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({}),
    cache: "no-store",
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(formatProviderHttpError("WorkBuddy", response, body, { endpointLabel: "token refresh endpoint" }));
  }

  const data = (await response.json().catch(() => ({}))) as WorkbuddyTokenResponse;
  const nextAccessToken = data.data?.accessToken?.trim() ?? "";
  if (data.code !== 0 || !nextAccessToken) {
    throw new Error("WorkBuddy token refresh returned an incomplete session");
  }

  return {
    accessToken: nextAccessToken,
    refreshToken: data.data?.refreshToken?.trim() || refreshToken,
    expiresAt: calculateExpiresAt(data.data ?? {}, 31536000),
    email: "",
  };
}
