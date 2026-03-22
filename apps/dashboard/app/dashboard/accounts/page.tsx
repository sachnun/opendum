import Link from "next/link";
import { getSession } from "@/lib/auth";
import { db } from "@opendum/shared/db";
import { providerAccount } from "@opendum/shared/db/schema";
import { eq } from "drizzle-orm";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle, AlertCircle, ArrowRight } from "lucide-react";
import { AddAccountDialog } from "@/components/dashboard/accounts/add-account-dialog";
import type { ProviderAccountIndicator } from "@/lib/navigation";
import {
  API_KEY_PROVIDER_ACCOUNT_DEFINITIONS,
  OAUTH_PROVIDER_ACCOUNT_DEFINITIONS,
  PROVIDER_ACCOUNT_DEFINITIONS,
  type ProviderAccountKey,
  getProviderAccountPath,
  getProviderSuccessMessage,
} from "@/lib/provider-accounts";

const WARNING_INDICATOR_STALE_WINDOW_MS = 5 * 60 * 60 * 1000;

const INDICATOR_WEIGHT: Record<ProviderAccountIndicator, number> = {
  normal: 0,
  warning: 1,
  error: 2,
};

const KNOWN_PROVIDER_KEYS = new Set<ProviderAccountKey>(
  PROVIDER_ACCOUNT_DEFINITIONS.map((provider) => provider.key)
);

function isKnownProvider(provider: string): provider is ProviderAccountKey {
  return KNOWN_PROVIDER_KEYS.has(provider as ProviderAccountKey);
}

function getAccountIndicator(
  lastErrorAt: Date | null,
  lastSuccessAt: Date | null
): ProviderAccountIndicator {
  if (!lastErrorAt) {
    return "normal";
  }

  const nowMs = Date.now();
  const errorTimeMs = lastErrorAt.getTime();
  const successTimeMs = lastSuccessAt?.getTime() ?? 0;
  const hasRecoveredAfterError = Boolean(lastSuccessAt && successTimeMs > errorTimeMs);

  if (!hasRecoveredAfterError) {
    return "error";
  }

  if (nowMs - errorTimeMs > WARNING_INDICATOR_STALE_WINDOW_MS) {
    return "normal";
  }

  return "warning";
}

function getIndicatorBadge(indicator: ProviderAccountIndicator, connectedAccounts: number) {
  if (connectedAccounts === 0) {
    return <Badge variant="outline">No Accounts</Badge>;
  }

  if (indicator === "error") {
    return <Badge variant="destructive">Needs Attention</Badge>;
  }

  if (indicator === "warning") {
    return (
      <Badge variant="outline" className="border-yellow-500 text-yellow-600">
        Recovering
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className="border-green-500 text-green-600">
      Healthy
    </Badge>
  );
}

type ProviderSummary = {
  connected: number;
  active: number;
  indicator: ProviderAccountIndicator;
};

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const session = await getSession();
  const params = await searchParams;

  if (!session?.user?.id) {
    return null;
  }

  const accounts = await db
    .select({
      provider: providerAccount.provider,
      isActive: providerAccount.isActive,
      lastErrorAt: providerAccount.lastErrorAt,
      lastSuccessAt: providerAccount.lastSuccessAt,
    })
    .from(providerAccount)
    .where(eq(providerAccount.userId, session.user.id));

  const summaryByProvider: Record<ProviderAccountKey, ProviderSummary> =
    Object.fromEntries(
      PROVIDER_ACCOUNT_DEFINITIONS.map((provider) => [
        provider.key,
        {
          connected: 0,
          active: 0,
          indicator: "normal" as ProviderAccountIndicator,
        },
      ])
    ) as Record<ProviderAccountKey, ProviderSummary>;

  for (const account of accounts) {
    if (!isKnownProvider(account.provider)) {
      continue;
    }

    const providerSummary = summaryByProvider[account.provider];
    providerSummary.connected += 1;

    if (!account.isActive) {
      continue;
    }

    providerSummary.active += 1;
    const indicator = getAccountIndicator(account.lastErrorAt, account.lastSuccessAt);
    if (INDICATOR_WEIGHT[indicator] > INDICATOR_WEIGHT[providerSummary.indicator]) {
      providerSummary.indicator = indicator;
    }
  }

  return (
    <div className="space-y-6">
      <div className="relative">
        <div className="fixed inset-x-0 top-16 z-20 bg-background pt-3 md:left-60 md:pt-5">
          <div className="mx-auto w-full max-w-7xl px-5 sm:px-6 lg:px-8">
            <div className="bg-background">
              <div className="border-b border-border pb-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-xl font-semibold">Provider Accounts</h2>
                  </div>
                  <div className="flex w-full items-center gap-2 sm:w-auto">
                    <AddAccountDialog triggerClassName="flex-1 sm:w-auto sm:flex-none" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="h-[88px] sm:h-[84px] md:h-[96px]" />
      </div>

      {params.success && (
        <Alert>
          <CheckCircle className="h-4 w-4" />
          <AlertDescription>{getProviderSuccessMessage(params.success)}</AlertDescription>
        </Alert>
      )}

      {params.error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to connect account: {decodeURIComponent(params.error)}
          </AlertDescription>
        </Alert>
      )}

      <section className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-base font-semibold">OAuth Provider Accounts</h3>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {OAUTH_PROVIDER_ACCOUNT_DEFINITIONS.map((provider) => {
            const summary = summaryByProvider[provider.key];

            return (
              <Link
                key={provider.key}
                href={getProviderAccountPath(provider.key)}
                className="group block"
              >
                <Card className="h-full transition-colors group-hover:border-primary/40">
                  <CardHeader className="space-y-1 pb-3">
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="text-base">{provider.label}</CardTitle>
                      {getIndicatorBadge(summary.indicator, summary.connected)}
                    </div>
                  </CardHeader>
                  <CardContent className="flex items-center justify-between">
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="secondary">{summary.connected} connected</Badge>
                      <Badge variant="outline">{summary.active} active</Badge>
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-base font-semibold">API Key Provider Accounts</h3>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {API_KEY_PROVIDER_ACCOUNT_DEFINITIONS.map((provider) => {
            const summary = summaryByProvider[provider.key];

            return (
              <Link
                key={provider.key}
                href={getProviderAccountPath(provider.key)}
                className="group block"
              >
                <Card className="h-full transition-colors group-hover:border-primary/40">
                  <CardHeader className="space-y-1 pb-3">
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="text-base">{provider.label}</CardTitle>
                      {getIndicatorBadge(summary.indicator, summary.connected)}
                    </div>
                  </CardHeader>
                  <CardContent className="flex items-center justify-between">
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="secondary">{summary.connected} connected</Badge>
                      <Badge variant="outline">{summary.active} active</Badge>
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}
