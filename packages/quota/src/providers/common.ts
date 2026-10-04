import { getQuotaJson, putQuotaCache } from "#quota/lib/cache.ts";
import type { QuotaAccount, QuotaContext } from "#quota/types.ts";

export type Json = Record<string, unknown>;

export function quotaFallbackTier(account: QuotaAccount): string {
  const tier = account.tier?.trim();
  return tier ? tier : "free";
}

export async function fetchJsonData(
  ctx: QuotaContext,
  account: QuotaAccount,
  forceRefresh: boolean,
  cacheName: string,
  method: string,
  target: string,
  headers: Record<string, string>,
  body: unknown
): Promise<{ data: Json | null; error: string | null }> {
  let result;
  try {
    result = await getQuotaJson(ctx, account, forceRefresh, cacheName, method, target, headers, body);
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : String(error) };
  }
  if (result.statusCode < 200 || result.statusCode >= 300) {
    return { data: null, error: `HTTP ${result.statusCode} ${result.raw}` };
  }
  try {
    const parsed = JSON.parse(result.raw) as Json;
    void putQuotaCache(ctx, result);
    return { data: parsed, error: null };
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : String(error) };
  }
}
