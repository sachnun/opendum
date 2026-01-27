import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Key } from "lucide-react";
import { CreateApiKeyButton } from "./create-api-key-button";
import { ApiKeyActions } from "./api-key-actions";
import { CodeBlock } from "@/components/ui/code-block";
import { headers } from "next/headers";

export default async function ApiKeysPage() {
  const session = await auth();

  // Detect base URL from request headers
  const headersList = await headers();
  const host = headersList.get("host") || "localhost:3000";
  const protocol = host.includes("localhost") ? "http" : "https";
  const baseUrl = `${protocol}://${host}`;

  if (!session?.user?.id) {
    return null;
  }

  const apiKeys = await prisma.proxyApiKey.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl md:text-2xl font-bold tracking-tight">API Keys</h2>
          <p className="text-sm md:text-base text-muted-foreground">
            Manage your proxy API keys for accessing Opendum
          </p>
        </div>
        <CreateApiKeyButton />
      </div>

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
            <Card key={apiKey.id} className={!apiKey.isActive ? "opacity-60" : ""}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Key className="h-5 w-5 text-muted-foreground" />
                    <CardTitle className="text-lg">{apiKey.name ?? "Unnamed Key"}</CardTitle>
                  </div>
                  <Badge variant={apiKey.isActive ? "default" : "secondary"}>
                    {apiKey.isActive ? "Active" : "Disabled"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
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
            <CodeBlock
              language="bash"
              code={`# Add to your settings or environment
ANTHROPIC_BASE_URL=${baseUrl}
ANTHROPIC_AUTH_TOKEN=sk-your-api-key-here
ANTHROPIC_DEFAULT_SONNET_MODEL=iflow/deepseek-v3.2`}
            />
          </div>
          <div>
            <h4 className="font-medium mb-2">cURL (OpenAI compatible)</h4>
            <CodeBlock
              language="bash"
              code={`curl -X POST ${baseUrl}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer sk-your-api-key-here" \\
  -d '{
    "model": "iflow/deepseek-v3.2",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`}
            />
          </div>
          <div>
            <h4 className="font-medium mb-2">cURL (Anthropic compatible)</h4>
            <CodeBlock
              language="bash"
              code={`curl -X POST ${baseUrl}/v1/messages \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: sk-your-api-key-here" \\
  -H "anthropic-version: 2023-06-01" \\
  -d '{
    "model": "iflow/deepseek-v3.2",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
