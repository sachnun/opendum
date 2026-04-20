import Link from "next/link";
import { getSession } from "@/lib/auth";
import { db } from "@opendum/shared/db";
import { pinnedProvider, providerAccount, usageLog } from "@opendum/shared/db/schema";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertCircle, ArrowRight, BarChart3 } from "lucide-react";
import { AddAccountDialog } from "@/components/dashboard/accounts/add-account-dialog";
import { PinButton } from "@/components/dashboard/accounts/pin-button";
import { UsageSparkline } from "@/components/dashboard/shared/usage-sparkline";
import type { ProviderAccountIndicator } from "@/lib/navigation";
import {
  API_KEY_PROVIDER_ACCOUNT_DEFINITIONS,
  OAUTH_PROVIDER_ACCOUNT_DEFINITIONS,
  PROVIDER_ACCOUNT_DEFINITIONS,
  type ProviderAccountKey,
  getProviderAccountPath,
} from "@/lib/provider-accounts";

const WARNING_INDICATOR_STALE_WINDOW_MS = 5 * 60 * 60 * 1000;
const PROVIDER_STATS_DAYS = 30;
const PROVIDER_DURATION_LOOKBACK_HOURS = 24;

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

function buildDayKeys(days: number): string[] {
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  return Array.from({ length: days }, (_, index) => {
    const date = new Date(todayUtc);
    date.setUTCDate(todayUtc.getUTCDate() - (days - 1 - index));
    return date.toISOString().split("T")[0];
  });
}

function buildHourKeys(hours: number): string[] {
  const now = new Date();
  const currentHourUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours())
  );

  return Array.from({ length: hours }, (_, index) => {
    const date = new Date(currentHourUtc);
    date.setUTCHours(currentHourUtc.getUTCHours() - (hours - 1 - index));
    return date.toISOString();
  });
}

type ProviderStats = {
  totalRequests: number;
  successRate: number | null;
  dailyRequests: Array<{ date: string; count: number }>;
  avgDurationLastDay: number | null;
  durationLast24Hours: Array<{ time: string; avgDuration: number | null }>;
};

type RawProviderStats = {
  totalRequests: number;
  successfulRequests: number;
  dailyCounts: Map<string, number>;
  durationByHour: Map<string, { total: number; count: number }>;
};

function buildEmptyProviderStats(dayKeys: string[], hourKeys: string[]): ProviderStats {
  return {
    totalRequests: 0,
    successRate: null,
    dailyRequests: dayKeys.map((day) => ({ date: day, count: 0 })),
    avgDurationLastDay: null,
    durationLast24Hours: hourKeys.map((time) => ({ time, avgDuration: null })),
  };
}

function formatDuration(duration: number | null): string {
  if (duration === null) {
    return "-";
  }

  if (duration >= 1000) {
    return `${(duration / 1000).toFixed(2)}s`;
  }

  return `${duration}ms`;
}

function formatHourLabel(time: string): string {
  return time.slice(11, 16);
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
  stats: ProviderStats;
};

function ProviderOverviewCard({
  provider,
  summary,
  isPinned,
}: {
  provider: { key: ProviderAccountKey; label: string };
  summary: ProviderSummary;
  isPinned: boolean;
}) {
  const dailyValues = summary.stats.dailyRequests.map((point) => point.count);
  const durationValues = summary.stats.durationLast24Hours.map((point) => point.avgDuration ?? 0);
  const durationLabelPoints = [
    summary.stats.durationLast24Hours[0],
    summary.stats.durationLast24Hours[Math.floor(summary.stats.durationLast24Hours.length / 2)],
    summary.stats.durationLast24Hours[summary.stats.durationLast24Hours.length - 1],
  ].filter((point): point is { time: string; avgDuration: number | null } => Boolean(point));
  const peakRequests = Math.max(...dailyValues, 0);

  return (
    <Link
      href={getProviderAccountPath(provider.key)}
      className="group block"
    >
      <Card className="h-full transition-colors group-hover:border-primary/40">
        <CardHeader className="space-y-1 pb-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-1">
              <PinButton
                providerKey={provider.key}
                initialPinned={isPinned}
              />
              <CardTitle className="text-base">{provider.label}</CardTitle>
            </div>
            {getIndicatorBadge(summary.indicator, summary.connected)}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">{summary.connected} connected</Badge>
              <Badge variant="outline">{summary.active} active</Badge>
            </div>
            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </div>

          <div className="rounded-md border border-border/70 bg-muted/20 p-2.5 space-y-2">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <BarChart3 className="h-3 w-3" />
                30d
              </span>
              <span className="tabular-nums">{peakRequests.toLocaleString()} peak</span>
            </div>

            <div className="grid grid-cols-3 gap-1.5">
              <div className="rounded border border-border/60 bg-background/70 px-2 py-1.5">
                <p className="text-[10px] text-muted-foreground truncate">Requests</p>
                <p className="text-sm font-semibold text-foreground tabular-nums truncate">
                  {summary.stats.totalRequests.toLocaleString()}
                </p>
              </div>
              <div className="rounded border border-border/60 bg-background/70 px-2 py-1.5">
                <p className="text-[10px] text-muted-foreground truncate">Success</p>
                <p className="text-sm font-semibold text-foreground tabular-nums truncate">
                  {summary.stats.successRate === null ? "-" : `${summary.stats.successRate}%`}
                </p>
              </div>
              <div className="rounded border border-border/60 bg-background/70 px-2 py-1.5">
                <p className="text-[10px] text-muted-foreground truncate">Latency</p>
                <p className="text-sm font-semibold text-foreground tabular-nums truncate">
                  {formatDuration(summary.stats.avgDurationLastDay)}
                </p>
              </div>
            </div>

            <div className="rounded border border-border/60 bg-background/70 px-2 py-1.5">
              <UsageSparkline
                values={durationValues}
                color="var(--chart-2)"
                ariaLabel={`Average duration trend for ${provider.label} over last 24 hours`}
                emptyLabel="No duration data"
                className="h-6"
                height={24}
              />
              <div className="mt-0.5 grid grid-cols-3 text-[9px] text-muted-foreground">
                {durationLabelPoints.map((point) => (
                  <span key={point.time} className="text-center truncate">
                    {formatHourLabel(point.time)}
                  </span>
                ))}
              </div>
            </div>

            <UsageSparkline
              values={dailyValues}
              color="var(--chart-1)"
              ariaLabel={`Requests trend for ${provider.label}`}
            />
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

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

  const dayKeys = buildDayKeys(PROVIDER_STATS_DAYS);
  const dayKeySet = new Set(dayKeys);
  const hourKeys = buildHourKeys(PROVIDER_DURATION_LOOKBACK_HOURS);
  const hourKeySet = new Set(hourKeys);
  const statsStartDate = new Date(`${dayKeys[0]}T00:00:00.000Z`);
  const durationStartDate = new Date(hourKeys[0]);
  const dayBucketExpression = sql<Date>`date_trunc('day', ${usageLog.createdAt})`;
  const hourBucketExpression = sql<Date>`date_trunc('hour', ${usageLog.createdAt})`;

  const [accounts, pinnedRows, dailyUsageRows, durationRows] = await Promise.all([
    db
      .select({
        provider: providerAccount.provider,
        isActive: providerAccount.isActive,
        lastErrorAt: providerAccount.lastErrorAt,
        lastSuccessAt: providerAccount.lastSuccessAt,
      })
      .from(providerAccount)
      .where(eq(providerAccount.userId, session.user.id)),
    db
      .select({ providerKey: pinnedProvider.providerKey })
      .from(pinnedProvider)
      .where(eq(pinnedProvider.userId, session.user.id))
      .orderBy(asc(pinnedProvider.createdAt)),
    db
      .select({
        provider: providerAccount.provider,
        dayBucket: dayBucketExpression,
        requestCount: sql<number>`count(*)`,
        successCount: sql<number>`count(*) filter (where ${usageLog.statusCode} >= 200 and ${usageLog.statusCode} < 400)`,
      })
      .from(usageLog)
      .innerJoin(providerAccount, eq(usageLog.providerAccountId, providerAccount.id))
      .where(
        and(
          eq(usageLog.userId, session.user.id),
          eq(providerAccount.userId, session.user.id),
          gte(usageLog.createdAt, statsStartDate)
        )
      )
      .groupBy(providerAccount.provider, dayBucketExpression),
    db
      .select({
        provider: providerAccount.provider,
        hourBucket: hourBucketExpression,
        durationTotal: sql<number>`coalesce(sum(${usageLog.duration}), 0)`,
        durationCount: sql<number>`count(${usageLog.duration})`,
      })
      .from(usageLog)
      .innerJoin(providerAccount, eq(usageLog.providerAccountId, providerAccount.id))
      .where(
        and(
          eq(usageLog.userId, session.user.id),
          eq(providerAccount.userId, session.user.id),
          gte(usageLog.createdAt, durationStartDate)
        )
      )
      .groupBy(providerAccount.provider, hourBucketExpression),
  ]);

  const pinnedSet = new Set<string>(pinnedRows.map((r: { providerKey: string }) => r.providerKey));

  const summaryByProvider: Record<ProviderAccountKey, ProviderSummary> =
    Object.fromEntries(
      PROVIDER_ACCOUNT_DEFINITIONS.map((provider) => [
        provider.key,
        {
          connected: 0,
          active: 0,
          indicator: "normal" as ProviderAccountIndicator,
          stats: buildEmptyProviderStats(dayKeys, hourKeys),
        },
      ])
    ) as Record<ProviderAccountKey, ProviderSummary>;

  const rawStatsByProvider = new Map<ProviderAccountKey, RawProviderStats>();

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

  for (const row of dailyUsageRows) {
    if (!isKnownProvider(row.provider)) {
      continue;
    }

    const dayDate = row.dayBucket instanceof Date ? row.dayBucket : new Date(row.dayBucket);
    if (Number.isNaN(dayDate.getTime())) {
      continue;
    }

    const dayKey = dayDate.toISOString().split("T")[0];
    if (!dayKeySet.has(dayKey)) {
      continue;
    }

    const current = rawStatsByProvider.get(row.provider) ?? {
      totalRequests: 0,
      successfulRequests: 0,
      dailyCounts: new Map<string, number>(),
      durationByHour: new Map<string, { total: number; count: number }>(),
    };

    const requestCount = Number(row.requestCount) || 0;
    const successCount = Number(row.successCount) || 0;

    current.totalRequests += requestCount;
    current.successfulRequests += successCount;
    current.dailyCounts.set(dayKey, (current.dailyCounts.get(dayKey) ?? 0) + requestCount);
    rawStatsByProvider.set(row.provider, current);
  }

  for (const row of durationRows) {
    if (!isKnownProvider(row.provider)) {
      continue;
    }

    const hourDate = row.hourBucket instanceof Date ? row.hourBucket : new Date(row.hourBucket);
    if (Number.isNaN(hourDate.getTime())) {
      continue;
    }

    const hourKey = hourDate.toISOString();
    if (!hourKeySet.has(hourKey)) {
      continue;
    }

    const durationCount = Number(row.durationCount) || 0;
    const durationTotal = Number(row.durationTotal) || 0;
    if (durationCount <= 0) {
      continue;
    }

    const current = rawStatsByProvider.get(row.provider) ?? {
      totalRequests: 0,
      successfulRequests: 0,
      dailyCounts: new Map<string, number>(),
      durationByHour: new Map<string, { total: number; count: number }>(),
    };

    const durationBucket = current.durationByHour.get(hourKey) ?? { total: 0, count: 0 };
    durationBucket.total += durationTotal;
    durationBucket.count += durationCount;
    current.durationByHour.set(hourKey, durationBucket);
    rawStatsByProvider.set(row.provider, current);
  }

  for (const provider of PROVIDER_ACCOUNT_DEFINITIONS) {
    const providerStats = rawStatsByProvider.get(provider.key);
    if (!providerStats) {
      continue;
    }

    const durationLast24Hours = hourKeys.map((time) => {
      const durationBucket = providerStats.durationByHour.get(time);
      return {
        time,
        avgDuration:
          durationBucket && durationBucket.count > 0
            ? Math.round(durationBucket.total / durationBucket.count)
            : null,
      };
    });
    const durationTotalLastDay = Array.from(providerStats.durationByHour.values()).reduce(
      (sum, durationBucket) => sum + durationBucket.total,
      0
    );
    const durationCountLastDay = Array.from(providerStats.durationByHour.values()).reduce(
      (sum, durationBucket) => sum + durationBucket.count,
      0
    );

    summaryByProvider[provider.key].stats = {
      totalRequests: providerStats.totalRequests,
      successRate:
        providerStats.totalRequests > 0
          ? Math.round((providerStats.successfulRequests / providerStats.totalRequests) * 100)
          : null,
      dailyRequests: dayKeys.map((day) => ({
        date: day,
        count: providerStats.dailyCounts.get(day) ?? 0,
      })),
      avgDurationLastDay:
        durationCountLastDay > 0
          ? Math.round(durationTotalLastDay / durationCountLastDay)
          : null,
      durationLast24Hours,
    };
  }

  return (
    <div className="space-y-6">
      <div className="sticky top-0 z-20 -mx-5 bg-background px-5 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="border-b border-border pb-4 pt-3">
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

      {params.error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to connect account: {decodeURIComponent(params.error)}
          </AlertDescription>
        </Alert>
      )}

      <section className="space-y-4 md:space-y-2">
        <div className="space-y-1">
          <h3 className="text-base font-semibold">OAuth Provider Accounts</h3>
        </div>
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
          {OAUTH_PROVIDER_ACCOUNT_DEFINITIONS.map((provider) => {
            const summary = summaryByProvider[provider.key];

            return (
              <ProviderOverviewCard
                key={provider.key}
                provider={provider}
                summary={summary}
                isPinned={pinnedSet.has(provider.key)}
              />
            );
          })}
        </div>
      </section>

      <section className="space-y-4 md:space-y-2">
        <div className="space-y-1">
          <h3 className="text-base font-semibold">API Key Provider Accounts</h3>
        </div>
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
          {API_KEY_PROVIDER_ACCOUNT_DEFINITIONS.map((provider) => {
            const summary = summaryByProvider[provider.key];

            return (
              <ProviderOverviewCard
                key={provider.key}
                provider={provider}
                summary={summary}
                isPinned={pinnedSet.has(provider.key)}
              />
            );
          })}
        </div>
      </section>
    </div>
  );
}
