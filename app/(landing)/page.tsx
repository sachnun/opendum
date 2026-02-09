import { auth, signIn } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle } from "lucide-react";

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  OAuthAccountNotLinked:
    "We could not link this sign-in method to your existing account. Try your original provider once, then try again.",
  AccessDenied: "Access denied. Please try signing in again.",
};

function getAuthErrorMessage(error?: string) {
  if (!error) {
    return null;
  }

  return AUTH_ERROR_MESSAGES[error] ?? "Sign in failed. Please try again.";
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const [session, params] = await Promise.all([auth(), searchParams]);
  const authError = getAuthErrorMessage(
    params.error ? decodeURIComponent(params.error) : undefined
  );

  if (session) {
    redirect("/dashboard");
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background">
      <div className="mx-auto max-w-md px-4 text-center">
        <h1 className="text-3xl font-bold tracking-tighter sm:text-4xl">Opendum</h1>
        <p className="mt-4 font-mono text-sm text-muted-foreground">
          Your accounts, one API.
        </p>

        {authError && (
          <Alert variant="destructive" className="mt-6 text-left">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{authError}</AlertDescription>
          </Alert>
        )}

        <div className="mt-8 flex items-center justify-center gap-3">
          <form
            action={async () => {
              "use server";
              await signIn("github", { redirectTo: "/dashboard" });
            }}
          >
            <Button
              type="submit"
              variant="outline"
              size="icon-lg"
              aria-label="Continue with GitHub"
              className="rounded-full border-border/70 bg-background/80 text-foreground shadow-none transition hover:bg-muted/60"
            >
              <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
              </svg>
            </Button>
          </form>

          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: "/dashboard" });
            }}
          >
            <Button
              type="submit"
              variant="outline"
              size="icon-lg"
              aria-label="Continue with Google"
              className="rounded-full border-border/70 bg-background/80 text-foreground shadow-none transition hover:bg-muted/60"
            >
              <svg className="h-5 w-5" viewBox="0 0 48 48" aria-hidden="true">
                <path
                  fill="#FFC107"
                  d="M43.611 20.083H42V20H24v8h11.303C33.652 32.657 29.193 36 24 36c-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.27 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
                />
                <path
                  fill="#FF3D00"
                  d="M6.306 14.691l6.571 4.819C14.655 16.108 19.001 13 24 13c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.27 4 24 4c-7.682 0-14.318 4.337-17.694 10.691z"
                />
                <path
                  fill="#4CAF50"
                  d="M24 44c5.067 0 9.77-1.939 13.332-5.101l-6.157-5.209C29.116 35.091 26.659 36 24 36c-5.173 0-9.625-3.316-11.302-7.946l-6.522 5.025C9.523 39.556 16.227 44 24 44z"
                />
                <path
                  fill="#1976D2"
                  d="M43.611 20.083H42V20H24v8h11.303c-.787 2.239-2.231 4.166-4.128 5.538l.003-.002 6.157 5.209C36.9 39.09 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
                />
              </svg>
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
