import Link from "next/link";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Key } from "lucide-react";
import { CreateApiKeyButton } from "@/components/dashboard/api-keys/create-api-key-button";
import { ApiKeyActions } from "@/components/dashboard/api-keys/api-key-actions";
import { EditableApiKeyName } from "@/components/dashboard/api-keys/editable-api-key-name";
import { ApiKeyModelAccess } from "@/components/dashboard/api-keys/api-key-model-access";
import type { ApiKeyModelAccessMode } from "@/lib/actions/api-keys";
import { getAllModels } from "@/lib/proxy/models";
import { formatRelativeTime } from "@/lib/date";

function getApiKeyStatus(apiKey: { isActive: boolean; expiresAt: Date | null }) {
  const now = new Date();
  if (!apiKey.isActive) {
    return { label: "Disabled", variant: "secondary" as const };
  }
  if (apiKey.expiresAt && apiKey.expiresAt < now) {
    return { label: "Expired", variant: "destructive" as const };
  }
  return { label: "Active", variant: "default" as const };
}

function normalizeModelAccessMode(mode: string): ApiKeyModelAccessMode {
  if (mode === "whitelist" || mode === "blacklist") {
    return mode;
  }
  return "all";
}

export default async function ApiKeysPage() {
  const session = await auth();

  if (!session?.user?.id) {
    return null;
  }

  const apiKeys = await prisma.proxyApiKey.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
  });

  const availableModels = getAllModels().sort((a, b) => a.localeCompare(b));

  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-border">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-xl font-semibold">API Keys</h2>
          <CreateApiKeyButton />
        </div>
      </div>

      {apiKeys.length === 0 ? (
        <Card className="bg-card">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <div className="mb-4 rounded-full bg-muted p-4">
              <Key className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold">No API keys</h3>
            <div className="mt-4">
              <CreateApiKeyButton />
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {apiKeys.map((apiKey) => {
            const status = getApiKeyStatus(apiKey);
            const isExpiredOrDisabled = status.label !== "Active";
            const modelAccessMode = normalizeModelAccessMode(apiKey.modelAccessMode);

            return (
              <Card
                key={apiKey.id}
                className={`bg-card ${isExpiredOrDisabled ? "opacity-65" : ""}`}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Key className="h-5 w-5 text-muted-foreground" />
                      <EditableApiKeyName id={apiKey.id} name={apiKey.name} />
                    </div>
                    <Badge variant={status.variant}>{status.label}</Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                      <div>
                        <span className="text-muted-foreground">Created: </span>
                        <span>{new Date(apiKey.createdAt).toLocaleDateString()}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Expires: </span>
                        <span>
                          {apiKey.expiresAt
                            ? new Date(apiKey.expiresAt).toLocaleDateString()
                            : "Never"}
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Last used: </span>
                        <span>
                          {apiKey.lastUsedAt
                            ? formatRelativeTime(apiKey.lastUsedAt)
                            : "Never"}
                        </span>
                      </div>
                    </div>
                    <ApiKeyActions apiKey={apiKey} />
                  </div>

                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-3">
                    <ApiKeyModelAccess
                      apiKeyId={apiKey.id}
                      availableModels={availableModels}
                      initialMode={modelAccessMode}
                      initialModels={apiKey.modelAccessList}
                    />

                    <Link
                      href={`/dashboard?apiKey=${apiKey.id}`}
                      className="text-xs font-medium text-primary underline-offset-4 hover:underline"
                    >
                      View analytics
                    </Link>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
