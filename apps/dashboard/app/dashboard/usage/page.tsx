import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyInlineCode } from "@/components/ui/copy-inline-code";

const PROXY_URL = process.env.NEXT_PUBLIC_PROXY_URL;

export default async function UsagePage() {
  const baseUrl = PROXY_URL ? PROXY_URL.replace(/\/$/, "") + "/v1" : "http://localhost:4000/v1";

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
                Set <CopyInlineCode value={baseUrl} /> as your
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

        </CardContent>
      </Card>

      <Card className="bg-card">
        <CardHeader>
          <CardTitle>Compatibility reference</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <div className="min-w-0 space-y-3 rounded-lg border border-border bg-muted/30 p-4">
            <Badge variant="outline">OpenAI-compatible</Badge>
            <div>
              <p className="text-xs text-muted-foreground">Endpoint</p>
              <code className="break-all text-sm">POST {baseUrl}/chat/completions</code>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Auth header</p>
              <code className="break-all text-sm">Authorization: Bearer &lt;api_key&gt;</code>
            </div>
          </div>

          <div className="min-w-0 space-y-3 rounded-lg border border-border bg-muted/30 p-4">
            <Badge variant="outline">Anthropic</Badge>
            <div>
              <p className="text-xs text-muted-foreground">Endpoint</p>
              <code className="break-all text-sm">POST {baseUrl}/messages</code>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Auth headers</p>
              <div className="space-y-1">
                <code className="block break-all text-sm">x-api-key: &lt;api_key&gt;</code>
                <code className="block break-all text-sm">anthropic-version: 2023-06-01</code>
              </div>
            </div>
          </div>

          <div className="min-w-0 space-y-3 rounded-lg border border-border bg-muted/30 p-4">
            <Badge variant="outline">OpenAI Responses</Badge>
            <div>
              <p className="text-xs text-muted-foreground">Endpoint</p>
              <code className="break-all text-sm">POST {baseUrl}/responses</code>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Auth header</p>
              <code className="break-all text-sm">Authorization: Bearer &lt;api_key&gt;</code>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
