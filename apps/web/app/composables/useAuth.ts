import {
  clearAuthTokens,
  getActiveSessionToken,
  getImpersonationToken,
  getSessionToken,
  readAccessClaims,
  setAccessToken,
  setAuthTokens,
  setImpersonationToken,
  type AccessTokenClaims,
  type AuthUser,
} from "../../lib/auth-token";
import { resolveApiUrl } from "../../lib/api-url";

function sanitizeRedirect(value: string | undefined): string | null {
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

export function useAuth() {
  const config = useRuntimeConfig();
  const apiUrl = resolveApiUrl(config.public.apiUrl);

  const claims = useState<AccessTokenClaims | null>(stateKeys.authClaims, () => readAccessClaims());
  const hasSession = useState(stateKeys.authSession, () => Boolean(getSessionToken()));

  const user = computed<AuthUser | null>(() => claims.value?.user ?? null);
  const isAuthenticated = computed(() => hasSession.value);

  function syncFromStorage() {
    claims.value = readAccessClaims();
    hasSession.value = Boolean(getSessionToken());
  }

  function applyHandoff(tokens: { access: string; session: string }) {
    setAuthTokens(tokens);
    syncFromStorage();
  }

  function applyAccessToken(token: string) {
    setAccessToken(token);
    claims.value = readAccessClaims(token);
  }

  function expireSession() {
    clearAuthTokens();
    clearNuxtData();
    claims.value = null;
    hasSession.value = false;
  }

  async function requestAccessToken(sessionToken: string): Promise<string | null> {
    if (!sessionToken) return null;

    try {
      const result = await $fetch<{ token?: string }>(`${apiUrl}/api/auth/token`, {
        headers: { authorization: `Bearer ${sessionToken}` },
      });

      return result?.token ?? null;
    } catch {
      return null;
    }
  }

  async function refreshAccessToken(): Promise<boolean> {
    const activeSessionToken = getActiveSessionToken();
    if (!activeSessionToken) return false;

    const token = await requestAccessToken(activeSessionToken);
    if (token) {
      applyAccessToken(token);
      hasSession.value = true;
      return true;
    }

    if (!getImpersonationToken()) return false;

    setImpersonationToken(null);
    const fallback = await requestAccessToken(getSessionToken() ?? "");
    if (!fallback) return false;

    applyAccessToken(fallback);
    hasSession.value = true;
    return true;
  }

  async function startAudit(userId: string): Promise<AuthUser> {
    const sessionToken = getSessionToken();
    if (!sessionToken) throw new Error("Not signed in");

    let result: { session?: { token?: string }; user?: AuthUser };
    try {
      result = await $fetch<{ session?: { token?: string }; user?: AuthUser }>(`${apiUrl}/api/auth/admin/impersonate-user`, {
        method: "POST",
        headers: { authorization: `Bearer ${sessionToken}` },
        body: { userId },
      });
    } catch (error) {
      throw new Error(errorMessage(error, "Failed to start audit mode"));
    }

    const impersonationToken = result?.session?.token;
    if (!impersonationToken) throw new Error("Failed to start audit mode");

    setImpersonationToken(impersonationToken);
    if (!(await refreshAccessToken())) {
      setImpersonationToken(null);
      throw new Error("Failed to start audit mode");
    }

    return result.user ?? { id: userId, name: null, email: null, image: null };
  }

  async function stopAudit(): Promise<boolean> {
    const impersonationToken = getImpersonationToken();
    setImpersonationToken(null);

    if (impersonationToken) {
      await $fetch(`${apiUrl}/api/auth/sign-out`, {
        method: "POST",
        headers: { authorization: `Bearer ${impersonationToken}` },
        body: {},
      }).catch(() => undefined);
    }

    return await refreshAccessToken();
  }

  function signInUrl(provider: string, redirectPath?: string): string {
    const params = new URLSearchParams({ provider, to: window.location.origin });
    const redirect = sanitizeRedirect(redirectPath);
    if (redirect) params.set("redirect", redirect);

    return `${apiUrl}/api/auth/start?${params.toString()}`;
  }

  function startSignIn(provider: string, redirectPath?: string) {
    window.location.assign(signInUrl(provider, redirectPath));
  }

  async function signOut() {
    const sessionTokens = [getImpersonationToken(), getSessionToken()].filter((token): token is string => Boolean(token));
    expireSession();

    for (const sessionToken of sessionTokens) {
      await $fetch(`${apiUrl}/api/auth/sign-out`, {
        method: "POST",
        headers: { authorization: `Bearer ${sessionToken}` },
        body: {},
      }).catch(() => undefined);
    }
  }

  return {
    apiUrl,
    claims,
    user,
    isAuthenticated,
    applyHandoff,
    applyAccessToken,
    expireSession,
    refreshAccessToken,
    startAudit,
    stopAudit,
    signInUrl,
    startSignIn,
    signOut,
  };
}
