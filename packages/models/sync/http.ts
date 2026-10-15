/**
 * Shared fetch utilities for the model refresh scripts.
 *
 * The exported functions are Effect based, so retry, timeout, and typed
 * failure behaviour stays consistent across every provider scraper. The
 * `run*` prefixed helpers bridge into Promise based callers.
 */

import { Duration, Effect, Schedule } from "effect";
import { ModelFetchFailure, asError, modelFailureMessage } from "../errors.ts";

export const MAX_FETCH_ATTEMPTS = 3;
export const FETCH_TIMEOUT_MS = 20_000;
export const FETCH_RETRY_BASE_DELAY_MS = 1_000;
export const FETCH_RETRY_AFTER_CAP_MS = 30_000;

const RATE_LIMIT_STATUSES = new Set([429, 503]);

function retryAfterMs(response: Response): number {
  const header = response.headers.get("retry-after");
  if (!header) return 0;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, FETCH_RETRY_AFTER_CAP_MS);
  }

  const date = Date.parse(header);
  if (Number.isNaN(date)) return 0;

  return Math.min(Math.max(date - Date.now(), 0), FETCH_RETRY_AFTER_CAP_MS);
}

export function sleep(ms: number): Promise<void> {
  return Effect.runPromise(Effect.sleep(Duration.millis(ms)));
}

export interface FetchOptions {
  attempts?: number;
  timeout?: number;
  label?: string;
  headers?: Record<string, string>;
}

export type FetchResponseType = "json" | "text";

/**
 * Retries a transient Effect with an exponential, jittered schedule. The source
 * is evaluated once before the schedule applies, so `attempts` counts total
 * evaluations.
 */
export function retryTransient<A, E, R>(
  self: Effect.Effect<A, E, R>,
  attempts: number
): Effect.Effect<A, E, R> {
  const retries = Math.max(0, Math.trunc(attempts) - 1);
  if (retries === 0) return self;
  const policy = Schedule.exponential(Duration.millis(FETCH_RETRY_BASE_DELAY_MS)).pipe(
    Schedule.jittered,
    Schedule.upTo({ times: retries })
  );
  return Effect.retry(self, policy);
}

export function runOrThrow<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
  return Effect.runPromise(effect).catch((cause: unknown) => {
    throw asError(cause);
  });
}

export function request<T>(
  url: string,
  options: FetchOptions,
  decode: (response: Response) => T | Promise<T>
): Effect.Effect<T, ModelFetchFailure> {
  const {
    attempts = MAX_FETCH_ATTEMPTS,
    timeout = FETCH_TIMEOUT_MS,
    label = url,
    headers = {},
  } = options;

  const attempt = Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) {
        if (RATE_LIMIT_STATUSES.has(response.status)) {
          const wait = retryAfterMs(response);
          if (wait > 0) await sleep(wait);
        }
        throw new ModelFetchFailure({
          message: `Failed to fetch ${label} (${response.status} ${response.statusText})`,
          label,
          status: response.status,
        });
      }
      return decode(response);
    },
    catch: (cause) => {
      if (cause instanceof ModelFetchFailure) return cause;
      return new ModelFetchFailure({
        message: modelFailureMessage(cause),
        label,
        cause,
      });
    },
  });

  return retryTransient(attempt, attempts);
}

export function fetchWithRetry(
  url: string,
  options: FetchOptions & { responseType?: FetchResponseType } = {}
): Effect.Effect<unknown, ModelFetchFailure> {
  const { responseType = "json", ...rest } = options;
  const accept = responseType === "text" ? "text/plain" : "application/json";
  return request(
    url,
    { ...rest, headers: { Accept: accept, ...rest.headers } },
    (response) => (responseType === "text" ? response.text() : response.json())
  );
}

export function fetchJson(
  url: string,
  options: FetchOptions = {}
): Effect.Effect<unknown, ModelFetchFailure> {
  return fetchWithRetry(url, { ...options, responseType: "json" });
}

export function fetchText(
  url: string,
  options: FetchOptions = {}
): Effect.Effect<string, ModelFetchFailure> {
  return fetchWithRetry(url, { ...options, responseType: "text" }) as Effect.Effect<
    string,
    ModelFetchFailure
  >;
}

/**
 * Fetches a URL and decodes the response with a scraper specific function.
 * Decode failures are retried like transport failures, matching the previous
 * hand written loops.
 */
export function fetchDecoded<T>(
  url: string,
  options: FetchOptions,
  decode: (response: Response) => T | Promise<T>
): Effect.Effect<T, ModelFetchFailure> {
  return request(url, options, decode);
}

export function runFetchJson(url: string, options: FetchOptions = {}): Promise<unknown> {
  return runOrThrow(fetchJson(url, options));
}

export function runFetchText(url: string, options: FetchOptions = {}): Promise<string> {
  return runOrThrow(fetchText(url, options));
}
