import { createSignal } from "solid-js";
import {
  clearTokens,
  activeToken,
  impersonationToken,
  sessionToken,
  readClaims,
  setAccess,
  setTokens,
  setImpersonation,
  type AccessTokenClaims,
  type AuthUser,
} from "~/lib/auth-token";
import { baseApiUrl } from "~/lib/config";
import { clearQueries } from "~/lib/query";
import { raise, settle } from "~/lib/settle";
import { Routes } from "~/lib/routes";

const [claims, setClaims] = createSignal<AccessTokenClaims | null>(readClaims());
const [hasSession, setHasSession] = createSignal(Boolean(sessionToken()));

export const authClaims = claims;
export const isAuthenticated = hasSession;

export function currentUser(): AuthUser | null {
  return claims()?.user ?? null;
}

export function sanitizeRedirect(value: string | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return null;
  return value;
}

function errorMessage(error: unknown, fallback: string): string {
  if (!error || typeof error !== "object") return fallback;

  const payload = (error as { data?: unknown }).data;
  if (payload && typeof payload === "object") {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;

    const nested = (payload as { error?: { message?: unknown } }).error;
    if (nested && typeof nested.message === "string" && nested.message) return nested.message;
  }

  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message ? message : fallback;
}

export function syncFromStorage(): void {
  setClaims(readClaims());
  setHasSession(Boolean(sessionToken()));
}

export function applyHandoff(tokens: { access: string; session: string }): void {
  setTokens(tokens);
  syncFromStorage();
}

export function applyAccessToken(token: string): void {
  setAccess(token);
  setClaims(readClaims(token));
}

export function expireSession(): void {
  clearTokens();
  clearQueries([]);
  setClaims(null);
  setHasSession(false);
}

export function expireAndRedirect(navigate: (path: string) => void): void {
  expireSession();
  navigate(Routes.home);
}

async function requestAccessToken(token: string): Promise<string | null> {
  if (!token) return null;

  const fetched = await settle(async () => {
    const response = await fetch(`${baseApiUrl()}/api/auth/token`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error("Failed to fetch access token");
    return (await response.json()) as { token?: string };
  });
  return fetched.ok ? (fetched.value?.token ?? null) : null;
}

export async function refreshAccessToken(): Promise<boolean> {
  const activeSessionToken = activeToken();
  if (!activeSessionToken) return false;

  const token = await requestAccessToken(activeSessionToken);
  if (token) {
    applyAccessToken(token);
    setHasSession(true);
    return true;
  }

  if (!impersonationToken()) return false;

  setImpersonation(null);
  const fallback = await requestAccessToken(sessionToken() ?? "");
  if (!fallback) return false;

  applyAccessToken(fallback);
  setHasSession(true);
  return true;
}

export async function startAudit(userId: string): Promise<AuthUser> {
  const token = sessionToken();
  if (!token) raise(new Error("Not signed in"));

  const fetched = await settle(async () => {
    const response = await fetch(`${baseApiUrl()}/api/auth/admin/impersonate-user`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    if (!response.ok) throw new Error(`Failed to start audit mode: ${response.status}`);
    return (await response.json()) as { session?: { token?: string }; user?: AuthUser };
  });
  if (!fetched.ok) raise(new Error(errorMessage(fetched.error, "Failed to start audit mode")));
  const result = fetched.value;

  const auditToken = result?.session?.token;
  if (!auditToken) raise(new Error("Failed to start audit mode"));

  setImpersonation(auditToken);
  if (!(await refreshAccessToken())) {
    setImpersonation(null);
    raise(new Error("Failed to start audit mode"));
  }

  return result.user ?? { id: userId, name: null, email: null, image: null };
}

export async function stopAudit(): Promise<boolean> {
  const auditToken = impersonationToken();
  setImpersonation(null);

  if (auditToken) {
    await fetch(`${baseApiUrl()}/api/auth/sign-out`, {
      method: "POST",
      headers: { authorization: `Bearer ${auditToken}`, "content-type": "application/json" },
      body: "{}",
    }).catch(() => undefined);
  }

  return await refreshAccessToken();
}

export function loginUrl(provider: string, redirectPath?: string): string {
  const params = new URLSearchParams({ provider, to: window.location.origin });
  const redirect = sanitizeRedirect(redirectPath);
  if (redirect) params.set("redirect", redirect);

  return `${baseApiUrl()}/api/auth/start?${params.toString()}`;
}

export function startSignIn(provider: string, redirectPath?: string): void {
  window.location.assign(loginUrl(provider, redirectPath));
}

export async function signOut(): Promise<void> {
  const sessionTokens = [impersonationToken(), sessionToken()].filter((token): token is string => Boolean(token));
  expireSession();

  for (const token of sessionTokens) {
    await fetch(`${baseApiUrl()}/api/auth/sign-out`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    }).catch(() => undefined);
  }
}
