import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CheckCircle, AlertCircle } from "lucide-react";
import { AddAccountDialog } from "@/components/dashboard/accounts/add-account-dialog";
import { AccountsList } from "@/components/dashboard/accounts/accounts-list";
import { RefreshAccountsButton } from "@/components/dashboard/accounts/refresh-accounts-button";

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

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const session = await auth();
  const params = await searchParams;

  if (!session?.user?.id) {
    return null;
  }

  const accounts = await prisma.providerAccount.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
  });

  const dayKeys = buildDayKeys(ACCOUNT_STATS_DAYS);
  const dayKeySet = new Set(dayKeys);
  const statsStartDate = new Date(`${dayKeys[0]}T00:00:00.000Z`);
  const accountIds = accounts.map((account) => account.id);

  const usageLogs = accountIds.length
    ? await prisma.usageLog.findMany({
        where: {
          userId: session.user.id,
          providerAccountId: { in: accountIds },
          createdAt: { gte: statsStartDate },
        },
        select: {
          providerAccountId: true,
          statusCode: true,
          createdAt: true,
        },
      })
    : [];

  const statsByAccountId = new Map<
    string,
    {
      totalRequests: number;
      successfulRequests: number;
      dailyCounts: Map<string, number>;
    }
  >();

  for (const log of usageLogs) {
    if (!log.providerAccountId) {
      continue;
    }

    const dayKey = log.createdAt.toISOString().split("T")[0];
    if (!dayKeySet.has(dayKey)) {
      continue;
    }

    const current =
      statsByAccountId.get(log.providerAccountId) ??
      {
        totalRequests: 0,
        successfulRequests: 0,
        dailyCounts: new Map<string, number>(),
      };

    current.totalRequests += 1;

    if (log.statusCode !== null && log.statusCode >= 200 && log.statusCode < 400) {
      current.successfulRequests += 1;
    }

    current.dailyCounts.set(dayKey, (current.dailyCounts.get(dayKey) ?? 0) + 1);
    statsByAccountId.set(log.providerAccountId, current);
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

  // Group accounts by provider
  const iflowAccounts = accountsWithStats.filter((a) => a.provider === "iflow");
  const antigravityAccounts = accountsWithStats.filter((a) => a.provider === "antigravity");
  const qwenCodeAccounts = accountsWithStats.filter((a) => a.provider === "qwen_code");
  const geminiCliAccounts = accountsWithStats.filter((a) => a.provider === "gemini_cli");
  const codexAccounts = accountsWithStats.filter((a) => a.provider === "codex");
  const nvidiaNimAccounts = accountsWithStats.filter((a) => a.provider === "nvidia_nim");
  const ollamaCloudAccounts = accountsWithStats.filter((a) => a.provider === "ollama_cloud");
  const openRouterAccounts = accountsWithStats.filter((a) => a.provider === "openrouter");

  return (
    <div className="space-y-6">
      <div className="relative">
        <div className="md:fixed md:inset-x-0 md:top-16 md:z-20 md:left-60 md:bg-background md:pt-5">
            <div className="mx-auto w-full max-w-7xl md:px-5 lg:px-8">
            <div className="bg-background">
              <div className="pb-4 border-b border-border">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <h2 className="text-xl font-semibold">Provider Accounts</h2>
                  <div className="flex w-full items-center gap-2 sm:w-auto">
                    <RefreshAccountsButton />
                    <AddAccountDialog triggerClassName="w-full sm:w-auto" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="hidden h-[76px] md:block" />
      </div>

      {params.success && (
        <Alert>
          <CheckCircle className="h-4 w-4" />
          <AlertDescription>
            {params.success === "antigravity_added"
              ? "Antigravity account connected successfully!"
              : params.success === "qwen_code_added"
                ? "Qwen Code account connected successfully!"
                : params.success === "gemini_cli_added"
                  ? "Gemini CLI account connected successfully!"
                  : params.success === "codex_added"
                    ? "Codex account connected successfully!"
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

      <AccountsList
        antigravityAccounts={antigravityAccounts}
        iflowAccounts={iflowAccounts}
        geminiCliAccounts={geminiCliAccounts}
        qwenCodeAccounts={qwenCodeAccounts}
        codexAccounts={codexAccounts}
        nvidiaNimAccounts={nvidiaNimAccounts}
        ollamaCloudAccounts={ollamaCloudAccounts}
        openRouterAccounts={openRouterAccounts}
      />
    </div>
  );
}
