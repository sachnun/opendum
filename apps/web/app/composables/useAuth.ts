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
} from "~~/lib/auth-token";
import { raise, settle } from "~~/lib/settle";
import { apiUrl } from "~~/lib/api-url";

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
  const baseUrl = apiUrl(config.public.apiUrl);

  const claims = useState<AccessTokenClaims | null>(stateKeys.authClaims, () => readClaims());
  const hasSession = useState(stateKeys.authSession, () => Boolean(sessionToken()));

  const user = computed<AuthUser | null>(() => claims.value?.user ?? null);
  const isAuthenticated = computed(() => hasSession.value);

  function syncFromStorage() {
    claims.value = readClaims();
    hasSession.value = Boolean(sessionToken());
  }

  function applyHandoff(tokens: { access: string; session: string }) {
    setTokens(tokens);
    syncFromStorage();
  }

  function applyAccessToken(token: string) {
    setAccess(token);
    claims.value = readClaims(token);
  }

  function expireSession() {
    clearTokens();
    clearNuxtData();
    claims.value = null;
    hasSession.value = false;
  }

  async function requestAccessToken(sessionToken: string): Promise<string | null> {
    if (!sessionToken) return null;

    const fetched = await settle(() =>
      $fetch<{ token?: string }>(`${baseUrl}/api/auth/token`, {
        headers: { authorization: `Bearer ${sessionToken}` },
      })
    );
    return fetched.ok ? (fetched.value?.token ?? null) : null;
  }

  async function refreshAccessToken(): Promise<boolean> {
    const activeSessionToken = activeToken();
    if (!activeSessionToken) return false;

    const token = await requestAccessToken(activeSessionToken);
    if (token) {
      applyAccessToken(token);
      hasSession.value = true;
      return true;
    }

    if (!impersonationToken()) return false;

    setImpersonation(null);
    const fallback = await requestAccessToken(sessionToken() ?? "");
    if (!fallback) return false;

    applyAccessToken(fallback);
    hasSession.value = true;
    return true;
  }

  async function startAudit(userId: string): Promise<AuthUser> {
    const token = sessionToken();
    if (!token) raise(new Error("Not signed in"));

    const fetched = await settle(() =>
      $fetch<{ session?: { token?: string }; user?: AuthUser }>(`${baseUrl}/api/auth/admin/impersonate-user`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: { userId },
      })
    );
    if (!fetched.ok) raise(new Error(errorMessage(fetched.error, "Failed to start audit mode")));
    const result = fetched.value;

    const impersonationToken = result?.session?.token;
    if (!impersonationToken) raise(new Error("Failed to start audit mode"));

    setImpersonation(impersonationToken);
    if (!(await refreshAccessToken())) {
      setImpersonation(null);
      raise(new Error("Failed to start audit mode"));
    }

    return result.user ?? { id: userId, name: null, email: null, image: null };
  }

  async function stopAudit(): Promise<boolean> {
    const auditToken = impersonationToken();
    setImpersonation(null);

    if (auditToken) {
      await $fetch(`${baseUrl}/api/auth/sign-out`, {
        method: "POST",
        headers: { authorization: `Bearer ${auditToken}` },
        body: {},
      }).catch(() => undefined);
    }

    return await refreshAccessToken();
  }

  function loginUrl(provider: string, redirectPath?: string): string {
    const params = new URLSearchParams({ provider, to: window.location.origin });
    const redirect = sanitizeRedirect(redirectPath);
    if (redirect) params.set("redirect", redirect);

    return `${baseUrl}/api/auth/start?${params.toString()}`;
  }

  function startSignIn(provider: string, redirectPath?: string) {
    window.location.assign(loginUrl(provider, redirectPath));
  }

  async function signOut() {
    const sessionTokens = [impersonationToken(), sessionToken()].filter((token): token is string => Boolean(token));
    expireSession();

    for (const sessionToken of sessionTokens) {
      await $fetch(`${baseUrl}/api/auth/sign-out`, {
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
    loginUrl,
    startSignIn,
    signOut,
  };
}
