import type {
  ModelFamilyCounts,
  ProviderAccountCounts,
  ProviderAccountIndicator,
  ProviderAccountIndicators,
} from "~~/lib/navigation";
import type { AccountOverviewData, AccountPingData } from "~~/lib/api-types";
import { NAV_ITEMS, categorize } from "@opendum/models/ranking";
import { PROVIDER_ACCOUNT_DEFINITIONS } from "@opendum/providers/provider-accounts";

export interface ShellAccountSummary {
  accountCounts: ProviderAccountCounts;
  activeAccountCounts: ProviderAccountCounts;
  accountIndicators: ProviderAccountIndicators;
  pinnedProviders: string[];
  hasConnectedAccounts: boolean;
}

export const emptyAccountCounts = Object.fromEntries(
  PROVIDER_ACCOUNT_DEFINITIONS.map((definition) => [definition.key, 0])
) as unknown as ProviderAccountCounts;

export const emptyAccountIndicators = Object.fromEntries(
  PROVIDER_ACCOUNT_DEFINITIONS.map((definition) => [definition.key, "normal"])
) as unknown as ProviderAccountIndicators;

export const emptySummary: ShellAccountSummary = {
  accountCounts: { ...emptyAccountCounts },
  activeAccountCounts: { ...emptyAccountCounts },
  accountIndicators: { ...emptyAccountIndicators },
  pinnedProviders: [],
  hasConnectedAccounts: false,
};

export const emptyCounts = Object.fromEntries(NAV_ITEMS.map((family) => [family.anchorId, 0])) as ModelFamilyCounts;

export function toSummary(summary: AccountOverviewData | AccountPingData): ShellAccountSummary {
  const nextAccountCounts: ProviderAccountCounts = { ...emptyAccountCounts };
  const nextCounts: ProviderAccountCounts = { ...emptyAccountCounts };
  const nextAccountIndicators: ProviderAccountIndicators = { ...emptyAccountIndicators };
  let hasConnectedAccounts = "hasConnectedAccounts" in summary ? summary.hasConnectedAccounts : false;

  for (const [key, providerSummary] of Object.entries(summary.summaries) as Array<[string, { connected?: number; active: number; indicator: ProviderAccountIndicator } | undefined]>) {
    if (!providerSummary) continue;

    const connected = providerSummary.connected ?? providerSummary.active;
    if (connected > 0) hasConnectedAccounts = true;

    nextAccountCounts[key] = connected;
    nextCounts[key] = providerSummary.active;
    nextAccountIndicators[key] = providerSummary.indicator;
  }

  return {
    accountCounts: nextAccountCounts,
    activeAccountCounts: nextCounts,
    accountIndicators: nextAccountIndicators,
    pinnedProviders: summary.pinnedProviders,
    hasConnectedAccounts,
  };
}

export function familyCounts(counts: Record<string, number>) {
  const nextCounts = { ...emptyCounts };
  const anchorByFamily = new Map(NAV_ITEMS.map((family) => [family.name, family.anchorId]));

  for (const [rawFamily, count] of Object.entries(counts)) {
    const family = categorize(rawFamily);
    const anchorId = anchorByFamily.get(family);
    if (anchorId) {
      nextCounts[anchorId] = (nextCounts[anchorId] ?? 0) + count;
    }
  }

  return nextCounts;
}
