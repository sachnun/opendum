import { Effect, Option } from "effect";
import { getQuotaJson, putQuotaCache, type QuotaJsonResult } from "../cache.js";
import { asError } from "../../core/errors.js";
import type { QuotaAccount, QuotaContext } from "../types.js";

export type Json = Record<string, unknown>;

export function quotaFallbackTier(account: QuotaAccount): string {
  const tier = account.tier?.trim();
  return tier ? tier : "free";
}

export type QuotaAttempt =
  | { readonly ok: true; readonly result: QuotaJsonResult }
  | { readonly ok: false; readonly message: string };

export function quotaAttempt(
  ctx: QuotaContext,
  account: QuotaAccount,
  forceRefresh: boolean,
  cacheName: string,
  method: string,
  target: string,
  headers: Record<string, string>,
  body: unknown
): Effect.Effect<QuotaAttempt> {
  return getQuotaJson(ctx, account, forceRefresh, cacheName, method, target, headers, body).pipe(
    Effect.map((result): QuotaAttempt => ({ ok: true, result })),
    Effect.catch((cause): Effect.Effect<QuotaAttempt> =>
      Effect.succeed({ ok: false, message: asError(cause).message })
    )
  );
}

export type QuotaJsonData = { data: Json | null; error: string | null };

export function fetchJsonData(
  ctx: QuotaContext,
  account: QuotaAccount,
  forceRefresh: boolean,
  cacheName: string,
  method: string,
  target: string,
  headers: Record<string, string>,
  body: unknown
): Effect.Effect<QuotaJsonData> {
  return quotaAttempt(ctx, account, forceRefresh, cacheName, method, target, headers, body).pipe(
    Effect.flatMap((attempt) => {
      if (!attempt.ok) return Effect.succeed<QuotaJsonData>({ data: null, error: attempt.message });
      const { result } = attempt;
      if (result.statusCode < 200 || result.statusCode >= 300) {
        return Effect.succeed<QuotaJsonData>({
          data: null,
          error: `HTTP ${result.statusCode} ${result.raw}`,
        });
      }
      return Effect.gen(function* () {
        const parsed = yield* Effect.try(() => JSON.parse(result.raw) as Json).pipe(Effect.option);
        if (Option.isNone(parsed)) return { data: null, error: "response was not valid JSON" };
        yield* putQuotaCache(ctx, result);
        return { data: parsed.value, error: null };
      });
    })
  );
}
