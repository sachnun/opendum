import { Duration, Effect, Schedule } from "effect";
import { raise } from "@opendum/models/refresh/core/raise";

import {
  ModelFetchFailure,
  ModelTimeoutFailure,
  asError,
  isRetryable as retryableStatus,
  failureMessage,
} from "@opendum/models/errors";

export const MAX_FETCH_ATTEMPTS = 3;
export const FETCH_TIMEOUT_MS = 20_000;
export const TIMEOUT_GRACE_MS = 1_000;
export const RETRY_DELAY_MS = 1_000;
export const RETRY_CAP_MS = 30_000;

const retryDelayHint = new Map<string, number>();

function afterMs(response: Response): number {
  const header = response.headers.get("retry-after");
  if (!header) return 0;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, RETRY_CAP_MS);
  }

  const date = Date.parse(header);
  if (Number.isNaN(date)) return 0;

  return Math.min(Math.max(date - Date.now(), 0), RETRY_CAP_MS);
}

export function sleep(ms: number): Promise<void> {
  return Effect.runPromise(Effect.sleep(Duration.millis(ms)));
}

export function sleepEffect(ms: number): Effect.Effect<void> {
  return Effect.sleep(Duration.millis(ms));
}

export interface FetchOptions {
  attempts?: number;
  timeout?: number;
  label?: string;
  headers?: Record<string, string>;
}

export type FetchResponseType = "json" | "text" | "bytes";

export function retryTransient<A, E, R>(
  self: Effect.Effect<A, E, R>,
  attempts: number
): Effect.Effect<A, E, R> {
  const retries = Math.max(0, Math.trunc(attempts) - 1);
  if (retries === 0) return self;
  const policy = Schedule.exponential(Duration.millis(RETRY_DELAY_MS)).pipe(
    Schedule.jittered,
    Schedule.upTo({ times: retries })
  );
  return Effect.retry(self, policy);
}

export function fetchLabeled<A>(
  label: string,
  self: Effect.Effect<A, ModelFetchFailure | ModelTimeoutFailure>,
  attempts: number
): Effect.Effect<A, ModelFetchFailure | ModelTimeoutFailure> {
  return retryFetch(label, self, attempts);
}

function isRetryable(cause: ModelFetchFailure | ModelTimeoutFailure): boolean {
  if (cause._tag === "ModelTimeoutFailure") return true;
  return retryableStatus(cause.status);
}

function fetchSchedule(
  label: string,
  retries: number
): Schedule.Schedule<unknown, ModelFetchFailure | ModelTimeoutFailure> {
  return Schedule.exponential(Duration.millis(RETRY_DELAY_MS)).pipe(
    Schedule.jittered,
    Schedule.upTo({ times: retries }),
    Schedule.while(({ input }) => isRetryable(input as ModelFetchFailure | ModelTimeoutFailure)),
    Schedule.modifyDelay(({ duration }) => {
      const hint = retryDelayHint.get(label);
      if (hint === undefined) return Effect.succeed(duration);
      retryDelayHint.delete(label);
      return Effect.succeed(Duration.millis(Math.max(hint, Duration.toMillis(duration))));
    })
  ) as Schedule.Schedule<unknown, ModelFetchFailure | ModelTimeoutFailure>;
}

function retryFetch<A>(
  label: string,
  self: Effect.Effect<A, ModelFetchFailure | ModelTimeoutFailure>,
  attempts: number
): Effect.Effect<A, ModelFetchFailure | ModelTimeoutFailure> {
  const retries = Math.max(0, Math.trunc(attempts) - 1);
  if (retries === 0) return self;
  return Effect.retry(self, fetchSchedule(label, retries)).pipe(
    Effect.ensuring(Effect.sync(() => retryDelayHint.delete(label)))
  );
}

export function orThrow<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
  return Effect.runPromise(effect).catch((cause: unknown) => raise(asError(cause)));
}

export function runTyped<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect);
}

function requestFailure(label: string, cause: unknown, status?: number): ModelFetchFailure {
  if (cause instanceof ModelFetchFailure) return cause;
  return new ModelFetchFailure({
    message: failureMessage(cause),
    label,
    status,
    cause,
  });
}

function timeoutCause(cause: unknown): boolean {
  const name = (cause as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

function timeoutFailure(
  label: string,
  timeout: number,
  phase: "fetching" | "reading"
): ModelTimeoutFailure {
  return new ModelTimeoutFailure({
    message: `Timed out after ${timeout}ms ${phase} ${label}`,
    label,
    timeoutMs: timeout,
  });
}

export function request<T>(
  url: string,
  options: FetchOptions,
  decode: (response: Response) => T | Promise<T>
): Effect.Effect<T, ModelFetchFailure | ModelTimeoutFailure> {
  const {
    attempts = MAX_FETCH_ATTEMPTS,
    timeout = FETCH_TIMEOUT_MS,
    label = url,
    headers = {},
  } = options;

  const attempt = Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(url, {
          headers,
          signal: AbortSignal.timeout(timeout),
        }),
      catch: (cause) =>
        timeoutCause(cause) ? timeoutFailure(label, timeout, "fetching") : requestFailure(label, cause),
    });

    if (!response.ok) {
      const wait = afterMs(response);
      if (wait > 0) retryDelayHint.set(label, wait);
      return yield* Effect.fail(
        new ModelFetchFailure({
          message: `Failed to fetch ${label} (${response.status} ${response.statusText})`,
          label,
          status: response.status,
        })
      );
    }

    return yield* Effect.tryPromise({
      try: async () => decode(response) as T,
      catch: (cause) =>
        timeoutCause(cause)
          ? timeoutFailure(label, timeout, "reading")
          : requestFailure(label, cause, response.status),
    });
  });

  const bounded = attempt.pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(timeout + TIMEOUT_GRACE_MS),
      orElse: () => Effect.fail(timeoutFailure(label, timeout, "reading")),
    })
  );

  return retryFetch(label, bounded, attempts);
}

function accepts(responseType: FetchResponseType): string {
  if (responseType === "text") return "text/plain";
  if (responseType === "bytes") return "application/octet-stream";
  return "application/json";
}

async function decodeResponse(response: Response, responseType: FetchResponseType): Promise<unknown> {
  if (responseType === "text") return response.text();
  if (responseType === "bytes") return new Uint8Array(await response.arrayBuffer());
  return response.json();
}

export function fetchRetry(
  url: string,
  options: FetchOptions & { responseType?: FetchResponseType } = {}
): Effect.Effect<unknown, ModelFetchFailure | ModelTimeoutFailure> {
  const { responseType = "json", ...rest } = options;
  return request(
    url,
    { ...rest, headers: { Accept: accepts(responseType), ...rest.headers } },
    (response) => decodeResponse(response, responseType)
  );
}

export function fetchJson(
  url: string,
  options: FetchOptions = {}
): Effect.Effect<unknown, ModelFetchFailure | ModelTimeoutFailure> {
  return fetchRetry(url, { ...options, responseType: "json" });
}

export function fetchText(
  url: string,
  options: FetchOptions = {}
): Effect.Effect<string, ModelFetchFailure | ModelTimeoutFailure> {
  return fetchRetry(url, { ...options, responseType: "text" }) as Effect.Effect<
    string,
    ModelFetchFailure | ModelTimeoutFailure
  >;
}

export function fetchBytes(
  url: string,
  options: FetchOptions = {}
): Effect.Effect<Uint8Array, ModelFetchFailure | ModelTimeoutFailure> {
  return fetchRetry(url, { ...options, responseType: "bytes" }) as Effect.Effect<
    Uint8Array,
    ModelFetchFailure | ModelTimeoutFailure
  >;
}

export function fetchDecoded<T>(
  url: string,
  options: FetchOptions,
  decode: (response: Response) => T | Promise<T>
): Effect.Effect<T, ModelFetchFailure | ModelTimeoutFailure> {
  return request(url, options, decode);
}

export function runJson(url: string, options: FetchOptions = {}): Promise<unknown> {
  return orThrow(fetchJson(url, options));
}

export function runText(url: string, options: FetchOptions = {}): Promise<string> {
  return orThrow(fetchText(url, options));
}

export function runBytes(url: string, options: FetchOptions = {}): Promise<Uint8Array> {
  return orThrow(fetchBytes(url, options));
}

export function fetchAll<A, E, R>(
  effects: ReadonlyArray<Effect.Effect<A, E, R>>,
  concurrency = 8
): Effect.Effect<Array<A>, E, R> {
  return Effect.forEach(effects, (effect) => effect, { concurrency });
}
