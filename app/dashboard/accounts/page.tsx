import { Suspense } from "react";
import { getSession } from "@/lib/auth";
import {
  getCachedAccountStats,
  setCachedAccountStats,
} from "@/lib/cache/accounts-cache";
import { db } from "@/lib/db";
import { providerAccount, usageLog } from "@/lib/db/schema";
import { eq, and, gte, inArray, desc, sql } from "drizzle-orm";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle, AlertCircle } from "lucide-react";
import { AddAccountDialog } from "@/components/dashboard/accounts/add-account-dialog";
import { AccountsList } from "@/components/dashboard/accounts/accounts-list";
import { RefreshAccountsButton } from "@/components/dashboard/accounts/refresh-accounts-button";

const ACCOUNT_STATS_DAYS = 30;
const ACCOUNT_SKELETON_CARDS = Array.from({ length: 3 });

interface AccountStats {
  totalRequests: number;
  successRate: number | null;
  dailyRequests: Array<{ date: string; count: number }>;
}

interface CachedAccountStatsPayload {
  statsByAccountId: Record<string, AccountStats>;
}

interface AccountStatsAggregateRow {
  providerAccountId: string | null;
  day: string;
  totalRequests: number;
  successfulRequests: number;
}

function getRecentDayKeys(days: number): string[] {
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  return Array.from({ length: days }, (_, index) => {
    const date = new Date(todayUtc);
    date.setUTCDate(todayUtc.getUTCDate() - (days - 1 - index));
    return date.toISOString().split("T")[0];
  });
}

function buildEmptyAccountStats(dayKeys: string[]): AccountStats {
  return {
    totalRequests: 0,
    successRate: null,
    dailyRequests: dayKeys.map((day) => ({ date: day, count: 0 })),
  };
}

async function computeAccountStatsByAccountId(
  userId: string,
  accountIds: string[]
): Promise<Record<string, AccountStats>> {
  if (accountIds.length === 0) {
    return {};
  }

  const dayKeys = getRecentDayKeys(ACCOUNT_STATS_DAYS);
  const statsStartDate = new Date(`${dayKeys[0]}T00:00:00.000Z`);

  const aggregatedUsageRows = await db
    .select({
      providerAccountId: usageLog.providerAccountId,
      day: sql<string>`DATE(${usageLog.createdAt})`.as("day"),
      totalRequests: sql<number>`COUNT(*)::int`.as("totalRequests"),
      successfulRequests:
        sql<number>`SUM(CASE WHEN ${usageLog.statusCode} >= 200 AND ${usageLog.statusCode} < 400 THEN 1 ELSE 0 END)::int`.as(
          "successfulRequests"
        ),
    })
    .from(usageLog)
    .where(
      and(
        eq(usageLog.userId, userId),
        inArray(usageLog.providerAccountId, accountIds),
        gte(usageLog.createdAt, statsStartDate)
      )
    )
    .groupBy(usageLog.providerAccountId, sql`DATE(${usageLog.createdAt})`);

  const rawStatsByAccountId = new Map<
    string,
    {
      totalRequests: number;
      successfulRequests: number;
      dailyCounts: Map<string, number>;
    }
  >();

  for (const row of aggregatedUsageRows as AccountStatsAggregateRow[]) {
    if (!row.providerAccountId) {
      continue;
    }

    const current =
      rawStatsByAccountId.get(row.providerAccountId) ??
      {
        totalRequests: 0,
        successfulRequests: 0,
        dailyCounts: new Map<string, number>(),
      };

    current.totalRequests += row.totalRequests;
    current.successfulRequests += row.successfulRequests;
    current.dailyCounts.set(row.day, row.totalRequests);
    rawStatsByAccountId.set(row.providerAccountId, current);
  }

  return Object.fromEntries(
    accountIds.map((accountId) => {
      const accountStats = rawStatsByAccountId.get(accountId);
      if (!accountStats) {
        return [accountId, buildEmptyAccountStats(dayKeys)];
      }

      const stats: AccountStats = {
        totalRequests: accountStats.totalRequests,
        successRate:
          accountStats.totalRequests > 0
            ? Math.round((accountStats.successfulRequests / accountStats.totalRequests) * 100)
            : null,
        dailyRequests: dayKeys.map((day) => ({
          date: day,
          count: accountStats.dailyCounts.get(day) ?? 0,
        })),
      };

      return [accountId, stats];
    })
  );
}

async function getAccountStatsByAccountId(
  userId: string,
  accountIds: string[]
): Promise<Record<string, AccountStats>> {
  const cachedPayload = await getCachedAccountStats<CachedAccountStatsPayload>(userId);
  if (cachedPayload?.statsByAccountId) {
    return cachedPayload.statsByAccountId;
  }

  const statsByAccountId = await computeAccountStatsByAccountId(userId, accountIds);
  await setCachedAccountStats<CachedAccountStatsPayload>(userId, { statsByAccountId });
  return statsByAccountId;
}

function AccountsContentSkeleton() {
  return (
    <div className="space-y-8">
      <section className="space-y-5">
        <div className="space-y-1">
          <Skeleton className="h-5 w-52" />
          <Skeleton className="h-4 w-72" />
        </div>

        <div className="space-y-6">
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-5 w-24 rounded-full" />
            </div>

            <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              {ACCOUNT_SKELETON_CARDS.map((_, index) => (
                <div
                  key={`oauth-account-${index}`}
                  className="rounded-xl border border-border bg-card p-4 sm:p-5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-2">
                      <Skeleton className="h-5 w-32" />
                      <Skeleton className="h-4 w-24" />
                    </div>
                    <Skeleton className="h-5 w-16 rounded-full" />
                  </div>

                  <div className="mt-4 space-y-2 rounded-md border border-border/70 bg-muted/20 p-2.5">
                    <div className="flex items-center justify-between">
                      <Skeleton className="h-3 w-20" />
                      <Skeleton className="h-3 w-14" />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Skeleton className="h-12 w-full rounded-md" />
                      <Skeleton className="h-12 w-full rounded-md" />
                    </div>
                    <Skeleton className="h-12 w-full rounded-md" />
                  </div>

                  <div className="mt-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <Skeleton className="h-4 w-16" />
                      <Skeleton className="h-4 w-24" />
                    </div>
                    <div className="flex items-center justify-between">
                      <Skeleton className="h-4 w-20" />
                      <Skeleton className="h-4 w-10" />
                    </div>
                    <Skeleton className="h-12 w-full rounded-md" />
                  </div>

                  <div className="mt-4 flex gap-2">
                    <Skeleton className="h-8 w-8 rounded-md" />
                    <Skeleton className="h-8 w-8 rounded-md" />
                    <Skeleton className="h-8 w-8 rounded-md" />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-52" />
              <Skeleton className="h-5 w-24 rounded-full" />
            </div>

            <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              {ACCOUNT_SKELETON_CARDS.map((_, index) => (
                <div
                  key={`apikey-account-${index}`}
                  className="rounded-xl border border-border bg-card p-4 sm:p-5"
                >
                  <div className="space-y-2">
                    <Skeleton className="h-5 w-32" />
                    <Skeleton className="h-4 w-24" />
                  </div>
                  <Skeleton className="mt-4 h-16 w-full rounded-md" />
                  <div className="mt-4 flex gap-2">
                    <Skeleton className="h-8 w-8 rounded-md" />
                    <Skeleton className="h-8 w-8 rounded-md" />
                    <Skeleton className="h-8 w-8 rounded-md" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

interface AccountsContentProps {
  userId: string;
}

async function AccountsContent({ userId }: AccountsContentProps) {
  const accounts = await db
    .select()
    .from(providerAccount)
    .where(eq(providerAccount.userId, userId))
    .orderBy(desc(providerAccount.createdAt));

  const accountIds = accounts.map((account) => account.id);
  const dayKeys = getRecentDayKeys(ACCOUNT_STATS_DAYS);
  const statsByAccountId = await getAccountStatsByAccountId(userId, accountIds);

  const accountsWithStats = accounts.map((account) => ({
    ...account,
    stats: statsByAccountId[account.id] ?? buildEmptyAccountStats(dayKeys),
  }));

  // Group accounts by provider
  const iflowAccounts = accountsWithStats.filter((a) => a.provider === "iflow");
  const antigravityAccounts = accountsWithStats.filter((a) => a.provider === "antigravity");
  const qwenCodeAccounts = accountsWithStats.filter((a) => a.provider === "qwen_code");
  const copilotAccounts = accountsWithStats.filter((a) => a.provider === "copilot");
  const geminiCliAccounts = accountsWithStats.filter((a) => a.provider === "gemini_cli");
  const codexAccounts = accountsWithStats.filter((a) => a.provider === "codex");
  const kiroAccounts = accountsWithStats.filter((a) => a.provider === "kiro");
  const nvidiaNimAccounts = accountsWithStats.filter((a) => a.provider === "nvidia_nim");
  const ollamaCloudAccounts = accountsWithStats.filter((a) => a.provider === "ollama_cloud");
  const openRouterAccounts = accountsWithStats.filter((a) => a.provider === "openrouter");

  return (
    <AccountsList
      antigravityAccounts={antigravityAccounts}
      iflowAccounts={iflowAccounts}
      geminiCliAccounts={geminiCliAccounts}
      qwenCodeAccounts={qwenCodeAccounts}
      copilotAccounts={copilotAccounts}
      codexAccounts={codexAccounts}
      kiroAccounts={kiroAccounts}
      nvidiaNimAccounts={nvidiaNimAccounts}
      ollamaCloudAccounts={ollamaCloudAccounts}
      openRouterAccounts={openRouterAccounts}
    />
  );
}

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const session = await getSession();

  if (!session?.user?.id) {
    return null;
  }

  const params = await searchParams;

  return (
    <div className="space-y-6">
      <div className="relative">
        <div className="fixed inset-x-0 top-16 z-20 bg-background md:left-60 md:pt-5">
          <div className="mx-auto w-full max-w-7xl px-5 sm:px-6 lg:px-8">
            <div className="bg-background">
              <div className="pb-4 border-b border-border">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <h2 className="text-xl font-semibold">Provider Accounts</h2>
                  <div className="flex w-full items-center gap-2 sm:w-auto">
                    <RefreshAccountsButton />
                    <AddAccountDialog triggerClassName="flex-1 sm:w-auto sm:flex-none" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="h-[104px] sm:h-[76px]" />
      </div>

      {params.success && (
        <Alert>
          <CheckCircle className="h-4 w-4" />
          <AlertDescription>
            {params.success === "antigravity_added"
              ? "Antigravity account connected successfully!"
              : params.success === "qwen_code_added"
                ? "Qwen Code account connected successfully!"
                : params.success === "copilot_added"
                  ? "Copilot account connected successfully!"
                : params.success === "gemini_cli_added"
                  ? "Gemini CLI account connected successfully!"
                  : params.success === "codex_added"
                    ? "Codex account connected successfully!"
                    : params.success === "kiro_added"
                      ? "Kiro account connected successfully!"
                    : "Account connected successfully!"}
          </AlertDescription>
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

      <Suspense fallback={<AccountsContentSkeleton />}>
        <AccountsContent userId={session.user.id} />
      </Suspense>
    </div>
  );
}
