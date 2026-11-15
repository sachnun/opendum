import { onMount, type JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { applyHandoff } from "~/lib/auth";

export function AuthCallbackPage(): JSX.Element {
  const navigate = useNavigate();

  onMount(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const token = params.get("token") ?? "";
    const session = params.get("session") ?? "";
    const redirect = params.get("redirect");

    window.history.replaceState(null, "", window.location.pathname);

    if (!token || !session) {
      navigate("/?error=SessionExpired", { replace: true });
      return;
    }

    applyHandoff({ access: token, session });

    const target = redirect && redirect.startsWith("/") && !redirect.startsWith("//") ? redirect : "/";
    navigate(target, { replace: true });
  });

  return (
    <div class="flex h-dvh items-center justify-center bg-background font-mono text-sm text-muted-foreground">
      Signing you in...
    </div>
  );
}

export default AuthCallbackPage;
