import { Effect } from "effect";
import { quotaJson, putQuota, type QuotaJsonResult } from "../cache.js";
import { asError } from "../../core/errors.js";
import { Value } from "../../core/values.js";
import { errorInfo, expiredInfo } from "../helpers.js";
import type { AccountQuotaInfo, QuotaAccount, QuotaContext } from "../types.js";

export type Json = Record<string, unknown>;

export function fallbackTier(account: QuotaAccount): string {
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
  return quotaJson(ctx, account, forceRefresh, cacheName, method, target, headers, body).pipe(
    Effect.map((result): QuotaAttempt => ({ ok: true, result })),
    Effect.catch((cause): Effect.Effect<QuotaAttempt> =>
      Effect.succeed({ ok: false, message: asError(cause).message })
    )
  );
}

export class QuotaJson {
  static parse(text: string): Json | null {
    try {
      return Value.record(JSON.parse(text));
    } catch {
      return null;
    }
  }

  static expiredStatus(status: number): boolean {
    return status === 401 || status === 403;
  }

  static failedStatus(status: number): boolean {
    return status < 200 || status >= 300;
  }
}

export type QuotaPayloadOptions = {
  cache: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  label: string;
  expiredMessage?: string;
};

export type QuotaPayload =
  | { readonly ok: true; readonly data: Json; readonly result: QuotaJsonResult }
  | { readonly ok: false; readonly info: AccountQuotaInfo; readonly result?: QuotaJsonResult };

export function quotaPayload(
  ctx: QuotaContext,
  account: QuotaAccount,
  forceRefresh: boolean,
  options: QuotaPayloadOptions
): Effect.Effect<QuotaPayload> {
  const failure = (info: AccountQuotaInfo, result?: QuotaJsonResult) =>
    Effect.succeed<QuotaPayload>({ ok: false, info, result });
  return quotaAttempt(
    ctx,
    account,
    forceRefresh,
    options.cache,
    options.method,
    options.url,
    options.headers,
    options.body ?? null
  ).pipe(
    Effect.flatMap((attempt) => {
      if (!attempt.ok) return failure(errorInfo(attempt.message));
      const { result } = attempt;
      if (options.expiredMessage && QuotaJson.expiredStatus(result.statusCode)) {
        return failure(expiredInfo(options.expiredMessage), result);
      }
      if (QuotaJson.failedStatus(result.statusCode)) {
        return failure(
          errorInfo(`${options.label} quota endpoint failed: HTTP ${result.statusCode} ${result.raw}`),
          result
        );
      }
      const data = QuotaJson.parse(result.raw);
      if (!data) return failure(errorInfo(`${options.label} response was not valid JSON`), result);
      return putQuota(ctx, result).pipe(Effect.as({ ok: true as const, data, result }));
    })
  );
}
