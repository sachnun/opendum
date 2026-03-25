import Link from "next/link";
import { getSession } from "@/lib/auth";
import { db } from "@opendum/shared/db";
import { proxyApiKey, providerAccount } from "@opendum/shared/db/schema";
import { eq, desc, asc } from "drizzle-orm";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BarChart3, Key } from "lucide-react";
import { CreateApiKeyButton } from "@/components/dashboard/api-keys/create-api-key-button";
import { ApiKeyActions } from "@/components/dashboard/api-keys/api-key-actions";
import { EditableApiKeyName } from "@/components/dashboard/api-keys/editable-api-key-name";
import { ApiKeyModelAccess } from "@/components/dashboard/api-keys/api-key-model-access";
import { ApiKeyAccountAccess } from "@/components/dashboard/api-keys/api-key-account-access";
import type { ApiKeyModelAccessMode, ApiKeyAccountAccessMode } from "@/lib/actions/api-keys";
import { getAllModels } from "@opendum/shared/proxy/models";
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

function normalizeAccountAccessMode(mode: string): ApiKeyAccountAccessMode {
  if (mode === "whitelist" || mode === "blacklist") {
    return mode;
  }
  return "all";
}

export default async function ApiKeysPage() {
  const session = await getSession();

  if (!session?.user?.id) {
    return null;
  }

  const apiKeys = await db
    .select({
      id: proxyApiKey.id,
      name: proxyApiKey.name,
      keyPreview: proxyApiKey.keyPreview,
      isActive: proxyApiKey.isActive,
      createdAt: proxyApiKey.createdAt,
      expiresAt: proxyApiKey.expiresAt,
      lastUsedAt: proxyApiKey.lastUsedAt,
      modelAccessMode: proxyApiKey.modelAccessMode,
      modelAccessList: proxyApiKey.modelAccessList,
      accountAccessMode: proxyApiKey.accountAccessMode,
      accountAccessList: proxyApiKey.accountAccessList,
    })
    .from(proxyApiKey)
    .where(eq(proxyApiKey.userId, session.user.id))
    .orderBy(desc(proxyApiKey.createdAt));

  const providerAccounts = await db
    .select({
      id: providerAccount.id,
      provider: providerAccount.provider,
      name: providerAccount.name,
      email: providerAccount.email,
    })
    .from(providerAccount)
    .where(eq(providerAccount.userId, session.user.id))
    .orderBy(asc(providerAccount.provider), asc(providerAccount.name));

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
            const accountAccessMode = normalizeAccountAccessMode(apiKey.accountAccessMode);

            return (
              <Card
                key={apiKey.id}
                className={`bg-card ${isExpiredOrDisabled ? "opacity-65" : ""}`}
              >
                <CardContent className="px-5 py-3">
                  {/* Row 1: Name + Actions + Badge */}
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                    <EditableApiKeyName id={apiKey.id} name={apiKey.name} />
                    <div className="flex shrink-0 items-center gap-2">
                      <ApiKeyActions apiKey={apiKey} />
                      <Badge variant={status.variant} className="shrink-0">{status.label}</Badge>
                    </div>
                  </div>

                  {/* Row 2: Metadata + Access controls + Analytics */}
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                    <span className="text-xs text-muted-foreground">
                      {new Date(apiKey.createdAt).toLocaleDateString()}
                      {" · "}
                      {apiKey.expiresAt
                        ? `Exp ${new Date(apiKey.expiresAt).toLocaleDateString()}`
                        : "No expiry"}
                      {" · "}
                      {apiKey.lastUsedAt
                        ? `Used ${formatRelativeTime(apiKey.lastUsedAt)}`
                        : "Never used"}
                    </span>

                    <div className="flex flex-wrap items-center gap-2">
                      <ApiKeyModelAccess
                        apiKeyId={apiKey.id}
                        availableModels={availableModels}
                        initialMode={modelAccessMode}
                        initialModels={apiKey.modelAccessList}
                      />
                      <ApiKeyAccountAccess
                        apiKeyId={apiKey.id}
                        availableAccounts={providerAccounts}
                        initialMode={accountAccessMode}
                        initialAccounts={apiKey.accountAccessList}
                      />
                    </div>

                    <Link
                      href={`/dashboard/analistik/${apiKey.id}`}
                      className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
                      title="View analytics"
                    >
                      <BarChart3 className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Analytics</span>
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
