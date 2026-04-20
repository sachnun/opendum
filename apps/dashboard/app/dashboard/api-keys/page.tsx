import type { ReactNode } from "react";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { db } from "@opendum/shared/db";
import { proxyApiKey, proxyApiKeyRateLimit, providerAccount } from "@opendum/shared/db/schema";
import { eq, desc, asc, inArray } from "drizzle-orm";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BarChart3, ChevronDown, Key } from "lucide-react";
import { CreateApiKeyButton } from "@/components/dashboard/api-keys/create-api-key-button";
import { ApiKeyActions } from "@/components/dashboard/api-keys/api-key-actions";
import { EditableApiKeyName } from "@/components/dashboard/api-keys/editable-api-key-name";
import { ApiKeyModelAccess } from "@/components/dashboard/api-keys/api-key-model-access";
import { ApiKeyAccountAccess } from "@/components/dashboard/api-keys/api-key-account-access";
import { ApiKeyExpiration } from "@/components/dashboard/api-keys/api-key-expiration";
import { ApiKeyRateLimit } from "@/components/dashboard/api-keys/api-key-rate-limit";
import type { ApiKeyModelAccessMode, ApiKeyAccountAccessMode, RateLimitRuleInput } from "@/lib/actions/api-keys";
import { getAllModels, getAllFamilies } from "@opendum/shared/proxy/models";
import { formatRelativeTime } from "@/lib/date";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

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

function MobileApiKeySection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <>
      <div className="hidden lg:block h-full">{children}</div>
      <Collapsible defaultOpen={false} className="rounded-xl border border-border/70 bg-muted/20 lg:hidden">
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-semibold [&[data-state=open]>svg]:rotate-180">
          <span>{title}</span>
          <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform" />
        </CollapsibleTrigger>
        <CollapsibleContent className="px-4 pb-4">{children}</CollapsibleContent>
      </Collapsible>
    </>
  );
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

  const apiKeyIds = apiKeys.map((key) => key.id);
  const rateLimitRulesData =
    apiKeyIds.length > 0
      ? await db
          .select({
            apiKeyId: proxyApiKeyRateLimit.apiKeyId,
            target: proxyApiKeyRateLimit.target,
            targetType: proxyApiKeyRateLimit.targetType,
            perMinute: proxyApiKeyRateLimit.perMinute,
            perHour: proxyApiKeyRateLimit.perHour,
            perDay: proxyApiKeyRateLimit.perDay,
          })
          .from(proxyApiKeyRateLimit)
          .where(inArray(proxyApiKeyRateLimit.apiKeyId, apiKeyIds))
      : [];

  const rateLimitsByKeyId = new Map<string, RateLimitRuleInput[]>();
  for (const row of rateLimitRulesData) {
    const rules = rateLimitsByKeyId.get(row.apiKeyId) ?? [];
    rules.push({
      target: row.target,
      targetType: row.targetType as "model" | "family",
      perMinute: row.perMinute,
      perHour: row.perHour,
      perDay: row.perDay,
    });
    rateLimitsByKeyId.set(row.apiKeyId, rules);
  }

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
  const availableFamilies = getAllFamilies();

  return (
    <div className="space-y-6">
      <div className="border-b border-border pb-4">
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
            <p className="mt-1 text-sm text-muted-foreground">
              Create a key to manage model access, account access, and rate limits in one place.
            </p>
            <div className="mt-4">
              <CreateApiKeyButton />
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {apiKeys.map((apiKey) => {
            const status = getApiKeyStatus(apiKey);
            const isInactive = status.label !== "Active";
            const modelAccessMode = normalizeModelAccessMode(apiKey.modelAccessMode);
            const accountAccessMode = normalizeAccountAccessMode(apiKey.accountAccessMode);
            const keyRateLimits = rateLimitsByKeyId.get(apiKey.id) ?? [];

            return (
              <Card
                key={apiKey.id}
                className={`bg-card ${isInactive ? "opacity-70" : ""}`}
              >
                <CardContent className="p-5 md:p-6">
                  <div className="space-y-5">
                    <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <EditableApiKeyName id={apiKey.id} name={apiKey.name} />
                          {status.label !== "Active" && <Badge variant={status.variant}>{status.label}</Badge>}
                        </div>
                      </div>

                      <div className="w-full xl:min-w-[420px] xl:max-w-[480px]">
                        <ApiKeyActions apiKey={apiKey} />
                      </div>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      <div className="rounded-xl border border-border/70 bg-muted/20 px-4 py-3">
                        <p className="text-[11px] text-muted-foreground">Created</p>
                        <p className="mt-1 text-sm font-medium">
                          {new Date(apiKey.createdAt).toLocaleDateString()}
                        </p>
                      </div>

                      <div className="rounded-xl border border-border/70 bg-muted/20 px-4 py-3">
                        <p className="text-[11px] text-muted-foreground">Expiration</p>
                        <div className="mt-1">
                          <ApiKeyExpiration
                            apiKeyId={apiKey.id}
                            initialExpiresAt={apiKey.expiresAt}
                          />
                        </div>
                      </div>

                      <div className="rounded-xl border border-border/70 bg-muted/20 px-4 py-3">
                        <p className="text-[11px] text-muted-foreground">Last used</p>
                        <p className="mt-1 text-sm font-medium">
                          {apiKey.lastUsedAt ? formatRelativeTime(apiKey.lastUsedAt) : "Never used"}
                        </p>
                      </div>

                      <Link
                        href={`/dashboard/analistik/${apiKey.id}`}
                        className="rounded-xl border border-border/70 bg-muted/20 px-4 py-3 transition-colors hover:border-border hover:bg-muted/35"
                        title="View analytics"
                      >
                        <p className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <BarChart3 className="h-3.5 w-3.5" />
                          Analytics
                        </p>
                        <p className="mt-1 text-sm font-medium">Open usage details</p>
                      </Link>
                    </div>

                    <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
                      <MobileApiKeySection title="Model Access">
                        <ApiKeyModelAccess
                          apiKeyId={apiKey.id}
                          availableModels={availableModels}
                          initialMode={modelAccessMode}
                          initialModels={apiKey.modelAccessList}
                        />
                      </MobileApiKeySection>

                      <MobileApiKeySection title="Account Access">
                        <ApiKeyAccountAccess
                          apiKeyId={apiKey.id}
                          availableAccounts={providerAccounts}
                          initialMode={accountAccessMode}
                          initialAccounts={apiKey.accountAccessList}
                        />
                      </MobileApiKeySection>

                      <MobileApiKeySection title="Rate Limits">
                        <ApiKeyRateLimit
                          apiKeyId={apiKey.id}
                          availableModels={availableModels}
                          availableFamilies={availableFamilies}
                          initialRules={keyRateLimits}
                        />
                      </MobileApiKeySection>
                    </div>
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
