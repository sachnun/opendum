import { describe, expect, it } from "bun:test";
import { NAV_ITEMS } from "@opendum/models/ranking";
import { PROVIDER_ACCOUNT_DEFINITIONS } from "@opendum/providers/provider-accounts";
import { emptyCounts, emptySummary, familyCounts, toSummary } from "~/lib/account-overview";
import type { AccountOverviewData, AccountPingData } from "~/lib/api-types";

const firstProvider = PROVIDER_ACCOUNT_DEFINITIONS[0]?.key as string;
const secondProvider = PROVIDER_ACCOUNT_DEFINITIONS[1]?.key as string;
const firstFamily = NAV_ITEMS[0];

function overview(summaries: AccountOverviewData["summaries"], pinnedProviders: string[] = []): AccountOverviewData {
  return { summaries, pinnedProviders, hasConnectedAccounts: false } as unknown as AccountOverviewData;
}

const stats = {
  totalRequests: 0,
  totalTokens: 0,
  successRate: null,
  dailyRequests: [],
  avgDurationLastDay: null,
  durationLast24Hours: [],
} as unknown as AccountOverviewData["summaries"][string]["stats"];

function providerSummary(active: number, connected: number | undefined, indicator: "normal" | "warning" | "error") {
  return (connected === undefined ? { active, indicator, stats } : { active, connected, indicator, stats }) as AccountOverviewData["summaries"][string];
}

describe("account overview summary", () => {
  it("starts from zeroed provider counts", () => {
    expect(Object.keys(emptySummary.accountCounts).sort()).toEqual(
      PROVIDER_ACCOUNT_DEFINITIONS.map((definition) => definition.key).sort()
    );
    expect(Object.values(emptySummary.accountCounts).every((count) => count === 0)).toBe(true);
    expect(Object.values(emptySummary.accountIndicators).every((indicator) => indicator === "normal")).toBe(true);
    expect(emptySummary.pinnedProviders).toEqual([]);
    expect(emptySummary.hasConnectedAccounts).toBe(false);
  });

  it("maps provider summaries into shell counts", () => {
    const summary = toSummary(
      overview(
        {
          [firstProvider]: providerSummary(2, 3, "warning"),
          [secondProvider]: providerSummary(1, 1, "error"),
        },
        [firstProvider]
      )
    );

    expect(summary.accountCounts[firstProvider]).toBe(3);
    expect(summary.activeAccountCounts[firstProvider]).toBe(2);
    expect(summary.accountIndicators[firstProvider]).toBe("warning");
    expect(summary.accountCounts[secondProvider]).toBe(1);
    expect(summary.accountIndicators[secondProvider]).toBe("error");
    expect(summary.pinnedProviders).toEqual([firstProvider]);
    expect(summary.hasConnectedAccounts).toBe(true);
  });

  it("falls back to the active count when connected is missing", () => {
    const summary = toSummary(
      overview({
        [firstProvider]: providerSummary(4, undefined, "normal"),
      })
    );

    expect(summary.accountCounts[firstProvider]).toBe(4);
  });

  it("treats a ping payload without hasConnectedAccounts as disconnected when empty", () => {
    const ping = { summaries: {}, pinnedProviders: [] } as unknown as AccountPingData;
    const summary = toSummary(ping);

    expect(summary.hasConnectedAccounts).toBe(false);
    expect(summary.pinnedProviders).toEqual([]);
  });

  it("keeps unknown provider keys untouched in the zeroed baseline", () => {
    const summary = toSummary(
      overview({
        "custom-provider": providerSummary(1, 2, "normal"),
      })
    );

    expect(summary.accountCounts["custom-provider"]).toBe(2);
    expect(summary.accountCounts[firstProvider]).toBe(0);
  });
});

describe("model family counts", () => {
  it("starts from zeroed family counts", () => {
    expect(Object.keys(emptyCounts).sort()).toEqual(NAV_ITEMS.map((family) => family.anchorId).sort());
    expect(Object.values(emptyCounts).every((count) => count === 0)).toBe(true);
  });

  it("aggregates raw family names into navigation anchors", () => {
    if (!firstFamily) return;

    const counts = familyCounts({ [firstFamily.name]: 3, [`${firstFamily.name}-preview`]: 2 });

    expect(counts[firstFamily.anchorId]).toBeGreaterThanOrEqual(3);
  });

  it("folds unknown families into the Others anchor", () => {
    const counts = familyCounts({ "unknown-family-xyz": 5 });

    expect(counts["other-models"]).toBe(5);
  });
});
