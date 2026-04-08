import { notFound } from "next/navigation";
import { getSession } from "@/lib/auth";
import { db } from "@opendum/shared/db";
import { pinnedProvider, providerAccount, providerAccountDisabledModel, usageLog } from "@opendum/shared/db/schema";
import { eq, and, gte, inArray, desc, sql } from "drizzle-orm";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle } from "lucide-react";
import { AddAccountDialog } from "@/components/dashboard/accounts/add-account-dialog";
import { PinButton } from "@/components/dashboard/accounts/pin-button";
import { AccountsList } from "@/components/dashboard/accounts/accounts-list";
import {
  type ProviderAccountKey,
  PROVIDER_ACCOUNT_BY_KEY,
  getProviderFromSlug,
} from "@/lib/provider-accounts";
import { getProviderModelSet } from "@opendum/shared/proxy/models";

const ACCOUNT_STATS_DAYS = 30;

function buildDayKeys(days: number): string[] {
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  return Array.from({ length: days }, (_, index) => {
    const date = new Date(todayUtc);
    date.setUTCDate(todayUtc.getUTCDate() - (days - 1 - index));
    return date.toISOString().split("T")[0];
  });
}

function createEmptyProviderAccountMap<T>(createValue: () => T): Record<ProviderAccountKey, T> {
  return {
    antigravity: createValue(),
    cerebras: createValue(),
    codex: createValue(),
    copilot: createValue(),
    kilo_code: createValue(),
    kiro: createValue(),
    gemini_cli: createValue(),
    groq: createValue(),
    qwen_code: createValue(),
    nvidia_nim: createValue(),
    ollama_cloud: createValue(),
    openrouter: createValue(),
    workers_ai: createValue(),
  };
}

export default async function ProviderAccountsPage({
  params,
  searchParams,
}: {
  params: Promise<{ provider: string }>;
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const session = await getSession();
  const routeParams = await params;
  const queryParams = await searchParams;

  if (!session?.user?.id) {
    return null;
  }

  const selectedProvider = getProviderFromSlug(routeParams.provider);
  if (!selectedProvider) {
    notFound();
  }

  const providerMeta = PROVIDER_ACCOUNT_BY_KEY[selectedProvider];

  const accounts = await db
    .select({
      id: providerAccount.id,
      name: providerAccount.name,
      provider: providerAccount.provider,
      email: providerAccount.email,
      isActive: providerAccount.isActive,
      requestCount: providerAccount.requestCount,
      lastUsedAt: providerAccount.lastUsedAt,
      expiresAt: providerAccount.expiresAt,
      tier: providerAccount.tier,
      status: providerAccount.status,
      errorCount: providerAccount.errorCount,
      consecutiveErrors: providerAccount.consecutiveErrors,
      lastErrorAt: providerAccount.lastErrorAt,
      lastErrorMessage: providerAccount.lastErrorMessage,
      lastErrorCode: providerAccount.lastErrorCode,
      successCount: providerAccount.successCount,
      lastSuccessAt: providerAccount.lastSuccessAt,
      createdAt: providerAccount.createdAt,
    })
    .from(providerAccount)
    .where(
      and(
        eq(providerAccount.userId, session.user.id),
        eq(providerAccount.provider, selectedProvider)
      )
    )
    .orderBy(desc(providerAccount.createdAt));

  const dayKeys = buildDayKeys(ACCOUNT_STATS_DAYS);
  const dayKeySet = new Set(dayKeys);
  const statsStartDate = new Date(`${dayKeys[0]}T00:00:00.000Z`);
  const accountIds = accounts.map((account) => account.id);
  const dayBucketExpression = sql<Date>`date_trunc('day', ${usageLog.createdAt})`;

  const dailyUsageRows = accountIds.length
    ? await db
        .select({
          providerAccountId: usageLog.providerAccountId,
          dayBucket: dayBucketExpression,
          requestCount: sql<number>`count(*)`,
          successCount: sql<number>`count(*) filter (where ${usageLog.statusCode} >= 200 and ${usageLog.statusCode} < 400)`,
        })
        .from(usageLog)
        .where(
          and(
            eq(usageLog.userId, session.user.id),
            inArray(usageLog.providerAccountId, accountIds),
            gte(usageLog.createdAt, statsStartDate)
          )
        )
        .groupBy(usageLog.providerAccountId, dayBucketExpression)
    : [];

  const statsByAccountId = new Map<
    string,
    {
      totalRequests: number;
      successfulRequests: number;
      dailyCounts: Map<string, number>;
    }
  >();

  for (const row of dailyUsageRows) {
    if (!row.providerAccountId) {
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

    const current =
      statsByAccountId.get(row.providerAccountId) ??
      {
        totalRequests: 0,
        successfulRequests: 0,
        dailyCounts: new Map<string, number>(),
      };

    const requestCount = Number(row.requestCount) || 0;
    const successCount = Number(row.successCount) || 0;

    current.totalRequests += requestCount;
    current.successfulRequests += successCount;
    current.dailyCounts.set(dayKey, (current.dailyCounts.get(dayKey) ?? 0) + requestCount);
    statsByAccountId.set(row.providerAccountId, current);
  }

  const accountsWithStats = accounts.map((account) => {
    const accountStats = statsByAccountId.get(account.id);
    const totalRequests = accountStats?.totalRequests ?? 0;
    const successfulRequests = accountStats?.successfulRequests ?? 0;

    return {
      ...account,
      stats: {
        totalRequests,
        successRate:
          totalRequests > 0 ? Math.round((successfulRequests / totalRequests) * 100) : null,
        dailyRequests: dayKeys.map((day) => ({
          date: day,
          count: accountStats?.dailyCounts.get(day) ?? 0,
        })),
      },
    };
  });

  const groupedAccounts = createEmptyProviderAccountMap<typeof accountsWithStats>(() => []);
  groupedAccounts[selectedProvider] = accountsWithStats;

  const providerModels = Array.from(getProviderModelSet(selectedProvider)).sort();

  // Query per-account disabled models
  const disabledModelsByAccountId: Record<string, string[]> = {};
  if (accountIds.length > 0) {
    const disabledModelRows = await db
      .select({
        providerAccountId: providerAccountDisabledModel.providerAccountId,
        model: providerAccountDisabledModel.model,
      })
      .from(providerAccountDisabledModel)
      .where(inArray(providerAccountDisabledModel.providerAccountId, accountIds));

    for (const row of disabledModelRows) {
      if (!disabledModelsByAccountId[row.providerAccountId]) {
        disabledModelsByAccountId[row.providerAccountId] = [];
      }
      disabledModelsByAccountId[row.providerAccountId].push(row.model);
    }
  }

  const pinnedProviderRows = await db
    .select({ providerKey: pinnedProvider.providerKey })
    .from(pinnedProvider)
    .where(eq(pinnedProvider.userId, session.user.id));

  const validProviderKeys = new Set<string>(Object.keys(PROVIDER_ACCOUNT_BY_KEY));
  const pinnedProviders = pinnedProviderRows
    .map((r: { providerKey: string }) => r.providerKey)
    .filter((k: string): k is ProviderAccountKey => validProviderKeys.has(k));

  return (
    <div className="space-y-6">
      <div className="sticky top-0 z-20 -mx-5 bg-background px-5 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="border-b border-border pb-4 pt-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="inline-flex items-center gap-2 text-xl font-semibold">
                <PinButton
                  providerKey={selectedProvider}
                  initialPinned={pinnedProviders.includes(selectedProvider)}
                />
                {providerMeta.label}
              </h2>
            </div>
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <AddAccountDialog
                initialProvider={selectedProvider}
                triggerClassName="flex-1 sm:w-auto sm:flex-none"
              />
            </div>
          </div>
        </div>
      </div>

      {queryParams.error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to connect: {decodeURIComponent(queryParams.error)}
          </AlertDescription>
        </Alert>
      )}

      <AccountsList
        antigravityAccounts={groupedAccounts.antigravity}
        geminiCliAccounts={groupedAccounts.gemini_cli}
        qwenCodeAccounts={groupedAccounts.qwen_code}
        copilotAccounts={groupedAccounts.copilot}
        codexAccounts={groupedAccounts.codex}
        kiroAccounts={groupedAccounts.kiro}
        nvidiaNimAccounts={groupedAccounts.nvidia_nim}
        ollamaCloudAccounts={groupedAccounts.ollama_cloud}
        openRouterAccounts={groupedAccounts.openrouter}
        groqAccounts={groupedAccounts.groq}
        cerebrasAccounts={groupedAccounts.cerebras}
        kiloCodeAccounts={groupedAccounts.kilo_code}
        workersAiAccounts={groupedAccounts.workers_ai}
        visibleProviders={[selectedProvider]}
        supportedModelsByProvider={{ [selectedProvider]: providerModels }}
        disabledModelsByAccountId={disabledModelsByAccountId}
        pinnedProviders={pinnedProviders}
      />
    </div>
  );
}
