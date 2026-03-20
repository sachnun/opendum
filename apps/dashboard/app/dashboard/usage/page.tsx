import Link from "next/link";
import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { headers } from "next/headers";

export default async function UsagePage() {
  const headersList = await headers();
  const forwardedHost = headersList.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || headersList.get("host") || "localhost:3000";
  const forwardedProto = headersList.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol =
    forwardedProto === "http" || forwardedProto === "https"
      ? forwardedProto
      : host.includes("localhost")
        ? "http"
        : "https";
  const baseUrl = `${protocol}://${host}`;

  return (
    <div className="space-y-6">
      <div className="border-b border-border pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold">Usage</h2>
          <Badge variant="secondary">Quickstart</Badge>
        </div>
      </div>

      <Card className="bg-card">
        <CardHeader>
          <CardTitle>Start in 3 steps</CardTitle>
          <CardDescription>
            Create an API key, set your base URL, then call the compatible endpoint.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ol className="space-y-3 text-sm">
            <li className="flex gap-3">
              <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs font-medium">
                1
              </span>
              <span>
                Create an API key from{" "}
                <Link
                  href="/dashboard/api-keys"
                  className="font-medium text-primary underline-offset-4 hover:underline"
                >
                  /dashboard/api-keys
                </Link>
                .
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs font-medium">
                2
              </span>
              <span>
                Set <code className="rounded bg-muted px-1 py-0.5 text-xs">{baseUrl}</code> as your
                API base URL.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs font-medium">
                3
              </span>
              <span>
                Send your key as <code className="rounded bg-muted px-1 py-0.5 text-xs">Bearer</code>{" "}
                for OpenAI-compatible requests or <code className="rounded bg-muted px-1 py-0.5 text-xs">x-api-key</code>{" "}
                for Anthropic-compatible requests.
              </span>
            </li>
          </ol>

          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Security tip</AlertTitle>
            <AlertDescription>
              Keep API keys in server-side environment variables and avoid exposing them in browser
              code.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      <Card className="bg-card">
        <CardHeader>
          <CardTitle>Compatibility reference</CardTitle>
          <CardDescription>Use the same base URL and pick the endpoint style you need.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
            <Badge variant="outline">OpenAI-compatible</Badge>
            <div>
              <p className="text-xs text-muted-foreground">Endpoint</p>
              <code className="text-sm">POST /v1/chat/completions</code>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Auth header</p>
              <code className="text-sm">Authorization: Bearer &lt;api_key&gt;</code>
            </div>
          </div>

          <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
            <Badge variant="outline">Anthropic</Badge>
            <div>
              <p className="text-xs text-muted-foreground">Endpoint</p>
              <code className="text-sm">POST /v1/messages</code>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Auth headers</p>
              <div className="space-y-1">
                <code className="block text-sm">x-api-key: &lt;api_key&gt;</code>
                <code className="block text-sm">anthropic-version: 2023-06-01</code>
              </div>
            </div>
          </div>

          <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
            <Badge variant="outline">OpenAI Responses</Badge>
            <div>
              <p className="text-xs text-muted-foreground">Endpoint</p>
              <code className="text-sm">POST /v1/responses</code>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Auth header</p>
              <code className="text-sm">Authorization: Bearer &lt;api_key&gt;</code>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
