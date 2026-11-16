import { onMount, type JSX } from "solid-js";
import { baseApiUrl } from "~/lib/config";
import { Routes } from "~/lib/routes";

const BRIDGE_QUERY_KEY = "opendum:oauth-bridge:query";
const BRIDGE_ATTEMPTS_KEY = "opendum:oauth-bridge:attempts";
const MAX_ATTEMPTS = 2;

export function OAuthBridgePage(): JSX.Element {
  onMount(() => {
    const query = new URLSearchParams(window.location.search).toString();
    if (query) {
      sessionStorage.setItem(BRIDGE_QUERY_KEY, query);
      window.history.replaceState(null, "", Routes.oauthBridge);
    }

    const stored = sessionStorage.getItem(BRIDGE_QUERY_KEY);
    if (!stored) return;

    const attempts = Number(sessionStorage.getItem(BRIDGE_ATTEMPTS_KEY) ?? "0");
    if (Number.isNaN(attempts) || attempts >= MAX_ATTEMPTS) {
      sessionStorage.removeItem(BRIDGE_ATTEMPTS_KEY);
      sessionStorage.removeItem(BRIDGE_QUERY_KEY);
      window.location.replace(`/?error=OAuthLoop`);
      return;
    }
    sessionStorage.setItem(BRIDGE_ATTEMPTS_KEY, String(attempts + 1));

    void resume(stored);
  });

  return (
    <div class="flex h-dvh items-center justify-center bg-background font-mono text-sm text-muted-foreground">
      Redirecting to sign in...
    </div>
  );
}

async function resume(query: string): Promise<void> {
  const authorized = await hasSession();
  if (!authorized) {
    window.location.replace(`/?redirect=${encodeURIComponent(Routes.oauthBridge)}`);
    return;
  }
  sessionStorage.removeItem(BRIDGE_ATTEMPTS_KEY);
  sessionStorage.removeItem(BRIDGE_QUERY_KEY);
  window.location.replace(`${baseApiUrl()}/api/auth/oauth2/authorize?${query}`);
}

async function hasSession(): Promise<boolean> {
  try {
    const response = await fetch(`${baseApiUrl()}/api/auth/get-session`, {
      credentials: "include",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return false;
    const session = (await response.json()) as { user?: unknown } | null;
    return Boolean(session?.user);
  } catch {
    return false;
  }
}

export default OAuthBridgePage;
