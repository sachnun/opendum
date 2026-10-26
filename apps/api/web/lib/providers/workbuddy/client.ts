import { Effect } from "effect";
import { fetchExternalEffect } from "#web/lib/external.js";
import { fromPromise } from "#web/lib/task.js";
import { unavailable } from "#web/errors.js";
import { httpError } from "../provider-http-errors.js";
import type { OAuthResult } from "../types.js";
import {
  ACCOUNTS_PATH,
  AUTH_STATE_PATH,
  AUTH_TOKEN_PATH,
  DEVICE_EXPIRY,
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

function expiresAt(data: WorkbuddyTokenData, fallbackSeconds: number): Date {
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

export const startDeviceFlow = Effect.fn("workbuddy.initiateDeviceCodeFlow")(function* () {
  const url = `${WORKBUDDY_BASE_URL}${AUTH_STATE_PATH}?platform=${encodeURIComponent(WORKBUDDY_PLATFORM)}`;
  const response = yield* fetchExternalEffect(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({}),
    cache: "no-store",
  });

  if (!response.ok) {
    const body = yield* readText(response);
    return yield* unavailable(httpError("WorkBuddy", response, body, { endpointLabel: "auth state endpoint" }));
  }

  const data = yield* readJson<WorkbuddyStateResponse>(response, {});
  const state = data.data?.state?.trim() ?? "";
  const authUrl = data.data?.authUrl?.trim() ?? "";
  if (!state || !authUrl) {
    return yield* unavailable("WorkBuddy auth state response is missing required fields");
  }

  return {
    deviceCode: state,
    userCode: "",
    verificationUrl: authUrl,
    verificationUrlComplete: authUrl,
    expiresIn: DEVICE_EXPIRY,
    interval: POLLING_INTERVAL_SECONDS,
  } satisfies WorkbuddyInitiateResult;
});

export const pollDeviceAuth = Effect.fn("workbuddy.pollDeviceCodeAuthorization")(
  function* (deviceCode: string) {
    const state = deviceCode.trim();
    if (!state) return { error: "WorkBuddy device code is missing. Please try again." };

    const url = `${WORKBUDDY_BASE_URL}${AUTH_TOKEN_PATH}?state=${encodeURIComponent(state)}`;
    const response = yield* fetchExternalEffect(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (!response.ok) {
      const body = yield* readText(response);
      return {
        error: httpError("WorkBuddy", response, body, { endpointLabel: "device token polling endpoint" }),
      };
    }

    const data = yield* readJson<WorkbuddyTokenResponse>(response, {});
    if (data.code === PENDING_TOKEN_CODE) return { pending: true as const };
    if (data.code !== 0 || !data.data) {
      if (!data.data) return { pending: true as const };
      const detail = typeof data.msg === "string" && data.msg ? `: ${data.msg}` : "";
      return { error: `WorkBuddy authorization failed (${data.code ?? "unknown"}${detail}). Please try again.` };
    }

    const accessToken = data.data.accessToken?.trim() ?? "";
    if (!accessToken) return { pending: true as const };

    const identity = yield* fetchWorkbuddyIdentity(accessToken, state);
    if (!identity) return { pending: true as const };

    return {
      accessToken,
      refreshToken: data.data.refreshToken?.trim() || accessToken,
      expiresAt: expiresAt(data.data, 31536000),
      email: identity.email,
      accountId: identity.uid,
    } satisfies OAuthResult;
  }
);

const fetchWorkbuddyIdentity = Effect.fn("workbuddy.fetchIdentity")(function* (
  accessToken: string,
  state: string
) {
  const baseHeaders = { Authorization: `Bearer ${accessToken}`, "X-Domain": WORKBUDDY_DOMAIN, Accept: "application/json" };

  const loginAccount = yield* Effect.gen(function* () {
    const loginResponse = yield* fetchExternalEffect(
      `${WORKBUDDY_BASE_URL}${LOGIN_ACCOUNT_PATH}?state=${encodeURIComponent(state)}`,
      { method: "GET", headers: baseHeaders, cache: "no-store" }
    );
    if (!loginResponse.ok) return null;
    const loginData = yield* readJson<WorkbuddyAccountResponse>(loginResponse, {});
    if (loginData.code === PENDING_ACCOUNT_CODE) return null;
    return firstAccount(loginData.data);
  }).pipe(Effect.catch(() => Effect.succeed(null)));

  if (loginAccount && accountUid(loginAccount)) {
    const withAccounts = yield* fetchWorkbuddyAccounts(accessToken, accountUid(loginAccount));
    const resolved = withAccounts ?? loginAccount;
    return { uid: accountUid(resolved), email: accountEmail(resolved) };
  }

  const fallback = yield* fetchWorkbuddyAccounts(accessToken, "");
  if (fallback && accountUid(fallback)) return { uid: accountUid(fallback), email: accountEmail(fallback) };
  return null;
});

const fetchWorkbuddyAccounts = Effect.fn("workbuddy.fetchAccounts")(function* (
  accessToken: string,
  uid: string
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "X-Domain": WORKBUDDY_DOMAIN,
    Accept: "application/json",
  };
  if (uid) headers["X-User-Id"] = uid;
  const response = yield* fetchExternalEffect(`${WORKBUDDY_BASE_URL}${ACCOUNTS_PATH}`, {
    method: "GET",
    headers,
    cache: "no-store",
  }).pipe(Effect.catch(() => Effect.succeed(null)));
  if (!response || !response.ok) return null;
  const data = yield* readJson<WorkbuddyAccountsResponse>(response, {});
  if (data.code !== 0 || !data.data) return null;
  const accounts = data.data.accounts ?? (data.data.account ? [data.data.account] : []);
  return accounts.find((entry) => entry && accountUid(entry)) ?? null;
});

function readText(response: Response) {
  return fromPromise(() => response.text().catch(() => ""), "Failed to read WorkBuddy response");
}

function readJson<T>(response: Response, fallback: T) {
  return fromPromise(
    async () => ((await response.json().catch(() => fallback)) as T),
    "Failed to read WorkBuddy response"
  );
}
