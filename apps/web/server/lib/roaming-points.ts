import { and, eq, inArray, ne, sql } from "drizzle-orm";

import { db, providerAccount, usageLog } from "@opendum/database";
import { MODEL_REGISTRY, resolveModelAlias } from "./proxy/models";

export const ROAMING_MINIMUM_POINTS = 1;

const POINTS_PER_MILLION = 1_000_000;

interface RoamingTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
}

/** Convert roaming token usage into points using the model's price (points per million tokens). */
export function roamingPointsForUsage(model: string, usage: RoamingTokenUsage): number {
  const cost = MODEL_REGISTRY[resolveModelAlias(model)]?.cost;
  let points = 0;

  if (cost) {
    const billableInput = Math.max(usage.inputTokens - usage.cachedTokens, 0);
    points = (
      billableInput * (cost.input ?? 0)
      + usage.cachedTokens * (cost.cacheRead ?? 0)
      + usage.outputTokens * (cost.output ?? 0)
      + usage.cacheWriteTokens * (cost.cacheWrite ?? 0)
    ) / POINTS_PER_MILLION;
  }

  return Math.max(ROAMING_MINIMUM_POINTS, Math.ceil(points));
}

/** Total roaming points a user's API keys consumed from other users' shared accounts. */
export async function roamingUsagePointsByApiKey(userId: string, apiKeyIds: string[]): Promise<Map<string, number>> {
  const pointsByKey = new Map<string, number>();
  if (apiKeyIds.length === 0) return pointsByKey;

  const rows = await db
    .select({
      apiKeyId: usageLog.proxyApiKeyId,
      model: usageLog.model,
      inputTokens: sql<number>`coalesce(sum(${usageLog.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${usageLog.outputTokens}), 0)`,
      cachedTokens: sql<number>`coalesce(sum(${usageLog.cachedTokens}), 0)`,
      cacheWriteTokens: sql<number>`coalesce(sum(${usageLog.cacheWriteTokens}), 0)`,
    })
    .from(usageLog)
    .innerJoin(providerAccount, eq(usageLog.providerAccountId, providerAccount.id))
    .where(and(
      eq(usageLog.userId, userId),
      inArray(usageLog.proxyApiKeyId, apiKeyIds),
      ne(providerAccount.userId, userId),
      sql`${usageLog.statusCode} >= 200`,
      sql`${usageLog.statusCode} < 400`,
    ))
    .groupBy(usageLog.proxyApiKeyId, usageLog.model);

  for (const row of rows) {
    if (!row.apiKeyId) continue;
    const points = roamingPointsForUsage(row.model, {
      inputTokens: Number(row.inputTokens ?? 0),
      outputTokens: Number(row.outputTokens ?? 0),
      cachedTokens: Number(row.cachedTokens ?? 0),
      cacheWriteTokens: Number(row.cacheWriteTokens ?? 0),
    });
    pointsByKey.set(row.apiKeyId, (pointsByKey.get(row.apiKeyId) ?? 0) + points);
  }

  return pointsByKey;
}
