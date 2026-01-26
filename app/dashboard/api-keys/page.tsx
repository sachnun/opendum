import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CheckCircle, Key } from "lucide-react";
import { CreateApiKeyButton } from "./create-api-key-button";
import { ApiKeyActions } from "./api-key-actions";

export default async function ApiKeysPage({
  searchParams,
}: {
  searchParams: Promise<{ newKey?: string }>;
}) {
  const session = await auth();
  const params = await searchParams;

  if (!session?.user?.id) {
    return null;
  }

  const apiKeys = await prisma.proxyApiKey.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">API Keys</h2>
          <p className="text-muted-foreground">
            Manage your proxy API keys for accessing the iFlow proxy
          </p>
        </div>
        <CreateApiKeyButton />
      </div>

      {params.newKey && (
        <Alert>
          <CheckCircle className="h-4 w-4" />
          <AlertDescription>
            <div className="space-y-2">
              <p className="font-medium">API key created successfully!</p>
              <code className="block rounded bg-muted p-2 text-sm break-all">
                {params.newKey}
              </code>
              <p className="text-sm text-muted-foreground">
                You can reveal and copy this key anytime from the list below.
              </p>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {apiKeys.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <div className="rounded-full bg-muted p-4 mb-4">
              <Key className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold">No API keys</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Create an API key to start using the proxy
            </p>
            <CreateApiKeyButton />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {apiKeys.map((apiKey) => (
            <Card key={apiKey.id}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Key className="h-5 w-5 text-muted-foreground" />
                    <CardTitle className="text-lg">{apiKey.name}</CardTitle>
                  </div>
                  <Badge variant={apiKey.isActive ? "default" : "secondary"}>
                    {apiKey.isActive ? "Active" : "Revoked"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <div className="flex gap-6 text-sm">
                    <div>
                      <span className="text-muted-foreground">Created: </span>
                      <span>{new Date(apiKey.createdAt).toLocaleDateString()}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Last used: </span>
                      <span>
                        {apiKey.lastUsedAt
                          ? new Date(apiKey.lastUsedAt).toLocaleDateString()
                          : "Never"}
                      </span>
                    </div>
                  </div>
                  <ApiKeyActions apiKey={apiKey} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Usage</CardTitle>
          <CardDescription>How to use your API key</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h4 className="font-medium mb-2">Claude Code / opencode</h4>
            <pre className="rounded bg-muted p-3 text-sm overflow-x-auto">
{`# Add to your settings or environment
ANTHROPIC_BASE_URL=https://your-domain.com
ANTHROPIC_AUTH_TOKEN=ifp_your-api-key-here
ANTHROPIC_DEFAULT_SONNET_MODEL=iflow/deepseek-v3.2`}
            </pre>
          </div>
          <div>
            <h4 className="font-medium mb-2">cURL (OpenAI compatible)</h4>
            <pre className="rounded bg-muted p-3 text-sm overflow-x-auto">
{`curl -X POST https://your-domain.com/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ifp_your-api-key-here" \\
  -d '{
    "model": "iflow/deepseek-v3.2",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`}
            </pre>
          </div>
          <div>
            <h4 className="font-medium mb-2">cURL (Anthropic compatible)</h4>
            <pre className="rounded bg-muted p-3 text-sm overflow-x-auto">
{`curl -X POST https://your-domain.com/v1/messages \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: ifp_your-api-key-here" \\
  -H "anthropic-version: 2023-06-01" \\
  -d '{
    "model": "iflow/deepseek-v3.2",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`}
            </pre>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
