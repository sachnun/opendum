import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { DashboardDataRefresher } from "@/components/layout/dashboard-data-refresher";
import {
  MODEL_FAMILY_NAV_ITEMS,
  getModelFamily,
} from "@/lib/model-families";
import { getAllModels } from "@/lib/proxy/models";
import type {
  ModelFamilyCounts,
  ProviderAccountIndicator,
  ProviderAccountIndicators,
  ProviderAccountCounts,
} from "@/lib/navigation";
import { Toaster } from "@/components/ui/sonner";

const WARNING_INDICATOR_STALE_WINDOW_MS = 5 * 60 * 60 * 1000;

const PROVIDER_KEY_BY_PROVIDER_NAME = {
  antigravity: "antigravity",
  copilot: "copilot",
  codex: "codex",
  iflow: "iflow",
  kiro: "kiro",
  gemini_cli: "gemini_cli",
  qwen_code: "qwen_code",
  nvidia_nim: "nvidia_nim",
  ollama_cloud: "ollama_cloud",
  openrouter: "openrouter",
} as const;

const INDICATOR_WEIGHT: Record<ProviderAccountIndicator, number> = {
  normal: 0,
  warning: 1,
  error: 2,
};

function isKnownProvider(provider: string): provider is keyof typeof PROVIDER_KEY_BY_PROVIDER_NAME {
  return provider in PROVIDER_KEY_BY_PROVIDER_NAME;
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

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/");
  }

  const providerAccounts = await prisma.providerAccount.findMany({
    where: { userId: session.user.id },
    select: {
      provider: true,
      isActive: true,
      lastErrorAt: true,
      lastSuccessAt: true,
    },
  });

  const accountCounts: ProviderAccountCounts = {
    antigravity: 0,
    copilot: 0,
    codex: 0,
    iflow: 0,
    kiro: 0,
    gemini_cli: 0,
    qwen_code: 0,
    nvidia_nim: 0,
    ollama_cloud: 0,
    openrouter: 0,
  };

  const activeAccountCounts: ProviderAccountCounts = {
    antigravity: 0,
    copilot: 0,
    codex: 0,
    iflow: 0,
    kiro: 0,
    gemini_cli: 0,
    qwen_code: 0,
    nvidia_nim: 0,
    ollama_cloud: 0,
    openrouter: 0,
  };

  const accountIndicators: ProviderAccountIndicators = {
    antigravity: "normal",
    copilot: "normal",
    codex: "normal",
    iflow: "normal",
    kiro: "normal",
    gemini_cli: "normal",
    qwen_code: "normal",
    nvidia_nim: "normal",
    ollama_cloud: "normal",
    openrouter: "normal",
  };

  for (const account of providerAccounts) {
    if (!isKnownProvider(account.provider)) {
      continue;
    }

    const providerKey = PROVIDER_KEY_BY_PROVIDER_NAME[account.provider];
    accountCounts[providerKey] += 1;

    if (!account.isActive) {
      continue;
    }

    activeAccountCounts[providerKey] += 1;

    const nextIndicator = getAccountIndicator(account.lastErrorAt, account.lastSuccessAt);
    if (INDICATOR_WEIGHT[nextIndicator] > INDICATOR_WEIGHT[accountIndicators[providerKey]]) {
      accountIndicators[providerKey] = nextIndicator;
    }
  }

  const familyAnchorByName = new Map(
    MODEL_FAMILY_NAV_ITEMS.map((item) => [item.name, item.anchorId] as const)
  );

  const modelFamilyCounts: ModelFamilyCounts = {};
  for (const item of MODEL_FAMILY_NAV_ITEMS) {
    modelFamilyCounts[item.anchorId] = 0;
  }

  for (const modelId of getAllModels()) {
    const family = getModelFamily(modelId);
    const anchorId = familyAnchorByName.get(family);
    if (!anchorId) {
      continue;
    }

    modelFamilyCounts[anchorId] += 1;
  }

  return (
    <div className="relative flex min-h-svh bg-background">
      <Sidebar
        accountCounts={accountCounts}
        activeAccountCounts={activeAccountCounts}
        accountIndicators={accountIndicators}
        modelFamilyCounts={modelFamilyCounts}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          accountCounts={accountCounts}
          activeAccountCounts={activeAccountCounts}
          accountIndicators={accountIndicators}
          modelFamilyCounts={modelFamilyCounts}
        />
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-7xl px-5 pb-8 pt-5 sm:px-6 lg:px-8">
            {children}
          </div>
        </main>
      </div>
      <DashboardDataRefresher />
      <Toaster />
    </div>
  );
}
