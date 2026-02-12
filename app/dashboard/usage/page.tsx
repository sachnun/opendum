import Link from "next/link";
import { AlertCircle, Bot, KeyRound, Link2, Terminal, type LucideIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CodeBlock } from "@/components/ui/code-block";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { headers } from "next/headers";

const DEFAULT_MODEL = "iflow/deepseek-v3.2";

type SnippetPreset = {
  value: "claude" | "openai" | "anthropic";
  tabLabel: string;
  tabHint: string;
  panelTitle: string;
  panelHint: string;
  protocolBadge: string;
  endpoint: string;
  auth: string;
  icon: LucideIcon;
  code: string;
};

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

  const claudeCodeExample = `ANTHROPIC_BASE_URL=${baseUrl}
ANTHROPIC_AUTH_TOKEN=sk-your-api-key-here
ANTHROPIC_DEFAULT_SONNET_MODEL=${DEFAULT_MODEL}`;

  const openAiCurlExample = `API_KEY=sk-your-api-key-here
BASE_URL=${baseUrl}

curl --request POST "$BASE_URL/v1/chat/completions" \\
  --header "Content-Type: application/json" \\
  --header "Authorization: Bearer $API_KEY" \\
  --data '{
    "model": "${DEFAULT_MODEL}",
    "messages": [
      { "role": "user", "content": "Hello!" }
    ]
  }'`;

  const anthropicCurlExample = `API_KEY=sk-your-api-key-here
BASE_URL=${baseUrl}

curl --request POST "$BASE_URL/v1/messages" \\
  --header "Content-Type: application/json" \\
  --header "x-api-key: $API_KEY" \\
  --header "anthropic-version: 2023-06-01" \\
  --data '{
    "model": "${DEFAULT_MODEL}",
    "max_tokens": 1024,
    "messages": [
      { "role": "user", "content": "Hello!" }
    ]
  }'`;

  const snippetPresets: SnippetPreset[] = [
    {
      value: "claude",
      tabLabel: "Claude Code / opencode",
      tabHint: "Best for local CLI workflows",
      panelTitle: "Anthropic-style environment setup",
      panelHint: "Set once in your shell and your client will use this gateway by default.",
      protocolBadge: "SDK / CLI",
      endpoint: "Resolved by your client",
      auth: "ANTHROPIC_AUTH_TOKEN=sk-your-api-key-here",
      icon: Bot,
      code: claudeCodeExample,
    },
    {
      value: "openai",
      tabLabel: "cURL OpenAI",
      tabHint: "POST /v1/chat/completions",
      panelTitle: "OpenAI-compatible request",
      panelHint: "Use Bearer auth and keep request format identical to OpenAI clients.",
      protocolBadge: "REST",
      endpoint: "POST /v1/chat/completions",
      auth: "Authorization: Bearer <api_key>",
      icon: Terminal,
      code: openAiCurlExample,
    },
    {
      value: "anthropic",
      tabLabel: "cURL Anthropic",
      tabHint: "POST /v1/messages",
      panelTitle: "Anthropic-compatible request",
      panelHint: "Send x-api-key and anthropic-version headers in every request.",
      protocolBadge: "REST",
      endpoint: "POST /v1/messages",
      auth: "x-api-key: <api_key>",
      icon: Terminal,
      code: anthropicCurlExample,
    },
  ];

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
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
            <Badge variant="outline">OpenAI compatible</Badge>
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
            <Badge variant="outline">Anthropic compatible</Badge>
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
        </CardContent>
      </Card>

      <Card className="bg-card">
        <CardHeader>
          <CardTitle>Ready-to-run snippets</CardTitle>
          <CardDescription>
            Replace the placeholder API key and run the snippet that matches your client.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">Base URL</Badge>
              <code className="rounded bg-background px-2 py-0.5 text-xs break-all">{baseUrl}</code>
            </div>
          </div>

          <Tabs defaultValue="claude" className="w-full">
            <TabsList className="grid h-auto w-full grid-cols-1 gap-2 bg-transparent p-0 sm:grid-cols-3">
              {snippetPresets.map((snippet) => (
                <TabsTrigger
                  key={snippet.value}
                  value={snippet.value}
                  className="h-auto items-start gap-2 rounded-lg border border-border bg-muted/20 px-3 py-3 text-left data-[state=active]:border-primary data-[state=active]:bg-primary/5"
                >
                  <snippet.icon className="mt-0.5 size-4 shrink-0" />
                  <span className="space-y-1">
                    <span className="block text-sm font-medium leading-none">{snippet.tabLabel}</span>
                    <span className="block text-xs text-muted-foreground">{snippet.tabHint}</span>
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>

            {snippetPresets.map((snippet) => (
              <TabsContent key={snippet.value} value={snippet.value} className="mt-4">
                <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
                  <div className="rounded-lg border border-border/70 bg-muted/20 p-4">
                    <div className="space-y-2">
                      <Badge variant="outline">{snippet.protocolBadge}</Badge>
                      <h3 className="text-sm font-semibold">{snippet.panelTitle}</h3>
                      <p className="text-xs text-muted-foreground">{snippet.panelHint}</p>
                    </div>

                    <div className="mt-4 space-y-3">
                      <div className="space-y-1.5">
                        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Link2 className="size-3.5" />
                          Endpoint
                        </p>
                        <code className="block rounded-md bg-background px-2.5 py-2 text-xs break-all">
                          {snippet.endpoint}
                        </code>
                      </div>

                      <div className="space-y-1.5">
                        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <KeyRound className="size-3.5" />
                          Auth
                        </p>
                        <code className="block rounded-md bg-background px-2.5 py-2 text-xs break-all">
                          {snippet.auth}
                        </code>
                      </div>

                      <div className="space-y-1.5">
                        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Terminal className="size-3.5" />
                          Default model
                        </p>
                        <code className="block rounded-md bg-background px-2.5 py-2 text-xs break-all">
                          {DEFAULT_MODEL}
                        </code>
                      </div>
                    </div>
                  </div>

                  <div className="overflow-hidden rounded-lg border border-border/70 bg-muted/20">
                    <CodeBlock
                      language="bash"
                      code={snippet.code}
                      className="rounded-none bg-transparent p-4"
                      showCopyButton
                      copyButtonLabel={`${snippet.tabLabel} snippet`}
                    />
                  </div>
                </div>
              </TabsContent>
            ))}
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
