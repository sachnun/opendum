import { createSignal, onMount, Show, type JSX } from "solid-js";
import { baseApiUrl } from "~/lib/config";

type ConsentResponse = { redirect: boolean; url: string };

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  "opendum:mcp": "Use your opendum account through MCP tools",
  offline_access: "Stay signed in and refresh access automatically",
  openid: "Confirm your identity",
  profile: "Read your basic profile",
  email: "Read your email address",
};

export function OAuthConsentPage(): JSX.Element {
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);

  const client = () => searchParams().get("client_id") ?? "";
  const scopes = () => (searchParams().get("scope") ?? "").split(" ").filter(Boolean);

  function searchParams(): URLSearchParams {
    return new URLSearchParams(window.location.search);
  }

  function oauthQuery(): string {
    return new URLSearchParams(window.location.search).toString();
  }

  async function respond(accept: boolean): Promise<void> {
    if (pending()) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`${baseApiUrl()}/api/auth/oauth2/consent`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ accept, oauth_query: oauthQuery() }),
      });
      if (!response.ok) {
        setError("The authorization request is no longer valid. Please try connecting again.");
        setPending(false);
        return;
      }
      const body = (await response.json()) as ConsentResponse;
      if (!body.redirect || !body.url) {
        setError("The authorization response was malformed. Please try connecting again.");
        setPending(false);
        return;
      }
      window.location.replace(body.url);
    } catch {
      setError("Could not reach opendum. Check your connection and try again.");
      setPending(false);
    }
  }

  onMount(() => {
    if (!oauthQuery()) {
      setError("No authorization request found. Please try connecting again.");
    }
  });

  return (
    <div class="flex h-dvh items-center justify-center bg-background px-4">
      <div class="w-full max-w-md rounded-xl border border-border/70 bg-card p-6 shadow-sm">
        <h1 class="text-xl font-semibold tracking-tight">Authorize access</h1>
        <p class="mt-2 text-sm text-muted-foreground">
          <span class="break-all font-mono text-xs">{client() || "An application"}</span> is requesting access to
          your opendum account.
        </p>

        <Show when={scopes().length > 0}>
          <ul class="mt-4 space-y-2 text-sm">
            {scopes().map((scope) => (
              <li class="flex items-start gap-2 rounded-lg border bg-background/50 px-3 py-2">
                <span class="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
                <span>
                  {SCOPE_DESCRIPTIONS[scope] ?? scope}
                  <span class="ml-2 font-mono text-xs text-muted-foreground">{scope}</span>
                </span>
              </li>
            ))}
          </ul>
        </Show>

        <Show when={error()}>
          <div role="alert" class="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error()}
          </div>
        </Show>

        <div class="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            class="rounded-lg border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted/60 disabled:opacity-50"
            disabled={pending()}
            onClick={() => void respond(false)}
          >
            Deny
          </button>
          <button
            type="button"
            class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            disabled={pending()}
            onClick={() => void respond(true)}
          >
            {pending() ? "Authorizing..." : "Allow"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default OAuthConsentPage;
