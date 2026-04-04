import { Suspense } from "react";
import { getSession } from "@/lib/auth";
import { db } from "@opendum/shared/db";
import { disabledModel, pinnedProvider, providerAccount } from "@opendum/shared/db/schema";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { HeaderSkeleton } from "@/components/layout/header-skeleton";

import {
  MODEL_FAMILY_NAV_ITEMS,
  categorizeModelFamily,
} from "@/lib/model-families";
import { getAllModels, getModelFamily as getModelFamilyFromRegistry } from "@opendum/shared/proxy/models";
import { getAccountModelAvailability, isModelUsableByAccounts } from "@opendum/shared/proxy/auth";
import type {
  ModelFamilyCounts,
  ProviderAccountIndicator,
  ProviderAccountIndicators,
  ProviderAccountCounts,
} from "@/lib/navigation";
import {
  type ModelStats,
  MODEL_STATS_DAYS,
  MODEL_DURATION_LOOKBACK_HOURS,
  buildDayKeys,
  buildHourKeys,
  buildEmptyModelStats,
  getModelStatsByModel,
} from "@/lib/model-stats";
import { Toaster } from "@/components/ui/sonner";
import { ModelFamilyCountsProvider } from "@/lib/model-family-counts-context";
import { PlaygroundPresetProvider } from "@/lib/playground-preset-context";
import type { ProviderAccountKey } from "@/lib/provider-accounts";
import { PROVIDER_ACCOUNT_DEFINITIONS } from "@/lib/provider-accounts";

const WARNING_INDICATOR_STALE_WINDOW_MS = 5 * 60 * 60 * 1000;

const PROVIDER_KEY_BY_PROVIDER_NAME = {
  antigravity: "antigravity",
  cerebras: "cerebras",
  copilot: "copilot",
  codex: "codex",
  kilo_code: "kilo_code",
  kiro: "kiro",
  gemini_cli: "gemini_cli",
  groq: "groq",
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
  const session = await getSession();

  if (!session?.user?.id) {
    redirect("/");
  }

  const [providerAccounts, disabledModels, pinnedProviderRows] = await Promise.all([
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
      .select({ model: disabledModel.model })
      .from(disabledModel)
      .where(eq(disabledModel.userId, session.user.id)),
    db
      .select({ providerKey: pinnedProvider.providerKey })
      .from(pinnedProvider)
      .where(eq(pinnedProvider.userId, session.user.id)),
  ]);

  const validProviderKeys = new Set<string>(
    PROVIDER_ACCOUNT_DEFINITIONS.map((d) => d.key)
  );

  let pinnedProviders: ProviderAccountKey[];

  if (pinnedProviderRows.length === 0) {
    const providersWithAccounts = new Set(
      providerAccounts.map((a: { provider: string }) => a.provider)
    );
    const autoPinKeys = PROVIDER_ACCOUNT_DEFINITIONS
      .filter((d) => providersWithAccounts.has(d.key))
      .slice(0, 5)
      .map((d) => d.key);

    const rowsToInsert = [
      ...autoPinKeys.map((key) => ({ userId: session.user.id, providerKey: key })),
      { userId: session.user.id, providerKey: "_auto_pinned" },
    ];

    if (rowsToInsert.length > 0) {
      await db.insert(pinnedProvider).values(rowsToInsert).onConflictDoNothing();
    }

    pinnedProviders = autoPinKeys;
  } else {
    pinnedProviders = pinnedProviderRows
      .map((r: { providerKey: string }) => r.providerKey)
      .filter((k: string): k is ProviderAccountKey => validProviderKeys.has(k));
  }

  const user = {
    name: session.user.name ?? null,
    email: session.user.email ?? null,
    image: session.user.image ?? null,
  };

  const accountCounts: ProviderAccountCounts = {
    antigravity: 0,
    cerebras: 0,
    copilot: 0,
    codex: 0,
    kilo_code: 0,
    kiro: 0,
    gemini_cli: 0,
    groq: 0,
    qwen_code: 0,
    nvidia_nim: 0,
    ollama_cloud: 0,
    openrouter: 0,
  };

  const activeAccountCounts: ProviderAccountCounts = {
    antigravity: 0,
    cerebras: 0,
    copilot: 0,
    codex: 0,
    kilo_code: 0,
    kiro: 0,
    gemini_cli: 0,
    groq: 0,
    qwen_code: 0,
    nvidia_nim: 0,
    ollama_cloud: 0,
    openrouter: 0,
  };

  const accountIndicators: ProviderAccountIndicators = {
    antigravity: "normal",
    cerebras: "normal",
    copilot: "normal",
    codex: "normal",
    kilo_code: "normal",
    kiro: "normal",
    gemini_cli: "normal",
    groq: "normal",
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

  // Set of providers the user has at least one active account for
  const activeProviderNames = new Set<string>();
  for (const account of providerAccounts) {
    if (account.isActive) {
      activeProviderNames.add(account.provider);
    }
  }

  // Get account-level model availability (considers per-account disabled models)
  const availability = await getAccountModelAvailability(session.user.id);

  const familyAnchorByName = new Map(
    MODEL_FAMILY_NAV_ITEMS.map((item) => [item.name, item.anchorId] as const)
  );

  const modelFamilyCounts: ModelFamilyCounts = {};
  for (const item of MODEL_FAMILY_NAV_ITEMS) {
    modelFamilyCounts[item.anchorId] = 0;
  }

  // Only count models that have at least one usable active account,
  // so sidebar counts stay in sync with the models page.
  const allModels = getAllModels().filter((model) =>
    isModelUsableByAccounts(model, availability)
  );

  for (const modelId of allModels) {
    const rawFamily = getModelFamilyFromRegistry(modelId);
    const family = categorizeModelFamily(rawFamily);
    const anchorId = familyAnchorByName.get(family);
    if (!anchorId) {
      continue;
    }

    modelFamilyCounts[anchorId] += 1;
  }

  const statsByModel = await getModelStatsByModel(session.user.id, allModels);
  const fallbackDayKeys = buildDayKeys(MODEL_STATS_DAYS);
  const fallbackHourKeys = buildHourKeys(MODEL_DURATION_LOOKBACK_HOURS);

  return (
    <ModelFamilyCountsProvider defaultCounts={modelFamilyCounts}>
      <PlaygroundPresetProvider>
        <div className="relative flex min-h-svh bg-background">
          <Sidebar
            accountCounts={accountCounts}
            activeAccountCounts={activeAccountCounts}
            accountIndicators={accountIndicators}
            modelFamilyCounts={modelFamilyCounts}
            pinnedProviders={pinnedProviders}
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <Suspense fallback={<HeaderSkeleton />}>
              <Header
                accountCounts={accountCounts}
                activeAccountCounts={activeAccountCounts}
                accountIndicators={accountIndicators}
                modelFamilyCounts={modelFamilyCounts}
                pinnedProviders={pinnedProviders}
                disabledModels={disabledModels}
                statsByModel={statsByModel}
                fallbackDayKeys={fallbackDayKeys}
                fallbackHourKeys={fallbackHourKeys}
                availableModelIds={allModels}
                activeProviderNames={Array.from(activeProviderNames)}
                user={user}
              />
            </Suspense>
            <main className="flex-1 overflow-y-auto">
              <div className="w-full px-5 pb-8 pt-5 sm:px-6 lg:px-8">
                {children}
              </div>
            </main>
          </div>

          <Toaster />
        </div>
      </PlaygroundPresetProvider>
    </ModelFamilyCountsProvider>
  );
}
