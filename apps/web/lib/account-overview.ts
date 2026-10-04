import type {
  ModelFamilyCounts,
  ProviderAccountCounts,
  ProviderAccountIndicator,
  ProviderAccountIndicators,
} from "./navigation";
import type { AccountOverviewData, AccountOverviewDeltaData, AccountOverviewResponse, AccountPingData } from "./api-types";
import { MODEL_FAMILY_NAV_ITEMS, categorizeModelFamily } from "./model-families";
import { PROVIDER_ACCOUNT_DEFINITIONS } from "./provider-accounts";

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

export const emptyShellAccountSummary: ShellAccountSummary = {
  accountCounts: { ...emptyAccountCounts },
  activeAccountCounts: { ...emptyAccountCounts },
  accountIndicators: { ...emptyAccountIndicators },
  pinnedProviders: [],
  hasConnectedAccounts: false,
};

export const emptyModelFamilyCounts = Object.fromEntries(MODEL_FAMILY_NAV_ITEMS.map((family) => [family.anchorId, 0])) as ModelFamilyCounts;

export function toShellAccountSummary(summary: AccountOverviewData | AccountPingData): ShellAccountSummary {
  const nextAccountCounts: ProviderAccountCounts = { ...emptyAccountCounts };
  const nextActiveAccountCounts: ProviderAccountCounts = { ...emptyAccountCounts };
  const nextAccountIndicators: ProviderAccountIndicators = { ...emptyAccountIndicators };
  let hasConnectedAccounts = "hasConnectedAccounts" in summary ? summary.hasConnectedAccounts : false;

  for (const [key, providerSummary] of Object.entries(summary.summaries) as Array<[string, { connected?: number; active: number; indicator: ProviderAccountIndicator } | undefined]>) {
    if (!providerSummary) continue;

    const connected = providerSummary.connected ?? providerSummary.active;
    if (connected > 0) hasConnectedAccounts = true;

    nextAccountCounts[key] = connected;
    nextActiveAccountCounts[key] = providerSummary.active;
    nextAccountIndicators[key] = providerSummary.indicator;
  }

  return {
    accountCounts: nextAccountCounts,
    activeAccountCounts: nextActiveAccountCounts,
    accountIndicators: nextAccountIndicators,
    pinnedProviders: summary.pinnedProviders,
    hasConnectedAccounts,
  };
}

export function isAccountOverviewDelta(summary: AccountOverviewResponse): summary is AccountOverviewDeltaData {
  return "delta" in summary && summary.delta === true;
}

export function normalizeModelFamilyCounts(counts: Record<string, number>) {
  const nextCounts = { ...emptyModelFamilyCounts };
  const anchorByFamily = new Map(MODEL_FAMILY_NAV_ITEMS.map((family) => [family.name, family.anchorId]));

  for (const [rawFamily, count] of Object.entries(counts)) {
    const family = categorizeModelFamily(rawFamily);
    const anchorId = anchorByFamily.get(family);
    if (anchorId) {
      nextCounts[anchorId] = (nextCounts[anchorId] ?? 0) + count;
    }
  }

  return nextCounts;
}
