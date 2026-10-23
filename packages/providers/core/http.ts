import { Duration, Effect, Schedule } from "effect";
import type { FallbackState } from "./fallback.js";
import { NoFallbackState, shouldUseFallbackEndpoint } from "./fallback.js";
import {
  ProviderFallbackFailure,
  ProviderRequestFailure,
  ProviderTransportFailure,
  asError,
  providerFailureMessage,
} from "./errors.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type EgressFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type UpstreamTransport = {
  readonly direct: FetchLike;
  readonly egress: EgressFetch | null;
  egressReady(): boolean;
};

export type MutableTransport = UpstreamTransport & {
  setEgress(egress: EgressFetch | null, ready: boolean): void;
};

export type Logger = (message: string, meta?: Record<string, unknown>) => void;

const EGRESS_MAX_TRIES = 3;
const EGRESS_FORBIDDEN_TRIES = 2;

export type EgressRetryPolicy = {
  forbidden: number;
  limited: number;
  transport: number;
};

const DEFAULT_EGRESS_RETRY: EgressRetryPolicy = {
  forbidden: EGRESS_FORBIDDEN_TRIES,
  limited: EGRESS_MAX_TRIES,
  transport: EGRESS_MAX_TRIES,
};

export function createTransport(direct: FetchLike): MutableTransport {
  const state: { egress: EgressFetch | null; ready: boolean } = {
    egress: null,
    ready: false,
  };

  return {
    direct,
    get egress(): EgressFetch | null {
      return state.egress;
    },
    egressReady: () => state.egress !== null && state.ready,
    setEgress(egress, ready) {
      state.egress = egress;
      state.ready = ready;
    },
  };
}

export function normalizeProviderFailure<A>(
  provider: string,
  effect: Effect.Effect<A, unknown>
): Effect.Effect<A, ProviderRequestFailure> {
  return Effect.catch(effect, (cause) =>
    Effect.fail(
      new ProviderRequestFailure({
        message: asError(cause).message,
        provider,
        cause,
      })
    )
  );
}

export function retryTransient<A, E, R>(
  self: Effect.Effect<A, E, R>,
  options: { attempts: number; baseDelayMs: number; factor?: number }
): Effect.Effect<A, E, R> {
  const retries = Math.max(0, Math.trunc(options.attempts) - 1);
  if (retries === 0) return self;
  const policy = Schedule.exponential(
    Duration.millis(Math.max(1, options.baseDelayMs)),
    options.factor ?? 2
  ).pipe(Schedule.jittered, Schedule.upTo({ times: retries }));
  return Effect.retry(self, policy);
}

export function transportFailure(
  provider: string,
  cause: unknown,
  url?: string
): ProviderTransportFailure {
  return new ProviderTransportFailure({
    message: providerFailureMessage(cause),
    provider,
    url,
    cause,
  });
}

export function fallbackFailure(provider: string, cause: unknown): ProviderFallbackFailure {
  return new ProviderFallbackFailure({
    message: providerFailureMessage(cause),
    provider,
    cause,
  });
}

export function postJSONWithHeadersAuth(
  provider: string,
  fetchFn: FetchLike,
  url: string,
  bearer: string,
  payload: unknown,
  stream: boolean,
  extraHeaders?: Record<string, string>,
  useAuth = true,
  onStart?: () => void
): Effect.Effect<Response, ProviderTransportFailure> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (useAuth) headers.Authorization = `Bearer ${bearer.trim()}`;
  headers.Accept = stream ? "text/event-stream" : "application/json";
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) headers[key] = value;
  }
  return Effect.tryPromise({
    try: async () => {
      const resp = await fetchFn(url, { method: "POST", headers, body: JSON.stringify(payload) });
      onStart?.();
      return resp;
    },
    catch: (cause) => transportFailure(provider, cause, url),
  });
}

export function postJSON(
  provider: string,
  fetchFn: FetchLike,
  url: string,
  bearer: string,
  payload: unknown,
  stream: boolean,
  onStart?: () => void
): Effect.Effect<Response, ProviderTransportFailure> {
  return postJSONWithHeadersAuth(provider, fetchFn, url, bearer, payload, stream, undefined, true, onStart);
}

export function postJSONWithHeaders(
  provider: string,
  fetchFn: FetchLike,
  url: string,
  bearer: string,
  payload: unknown,
  stream: boolean,
  extraHeaders?: Record<string, string>,
  onStart?: () => void
): Effect.Effect<Response, ProviderTransportFailure> {
  return postJSONWithHeadersAuth(provider, fetchFn, url, bearer, payload, stream, extraHeaders, true, onStart);
}

export function postJSONWithoutAuth(
  provider: string,
  fetchFn: FetchLike,
  url: string,
  payload: unknown,
  stream: boolean,
  onStart?: () => void
): Effect.Effect<Response, ProviderTransportFailure> {
  return postJSONWithHeadersAuth(provider, fetchFn, url, "", payload, stream, undefined, false, onStart);
}

export function postExecuteWithFallback(
  fetchFn: FetchLike,
  state: FallbackState | null,
  provider: string,
  primary: string,
  fallbackUrl: string,
  execute: (fetchFn: FetchLike, url: string) => Effect.Effect<Response, ProviderTransportFailure>
): Effect.Effect<Response, ProviderFallbackFailure> {
  const router = state ?? new NoFallbackState();
  const run = (target: string): Effect.Effect<Response, ProviderTransportFailure> => execute(fetchFn, target);

  if (!fallbackUrl) {
    return run(primary).pipe(Effect.mapError((cause) => fallbackFailure(provider, cause)));
  }

  return Effect.gen(function* () {
    if (yield* router.sticky(provider)) {
      const resp = yield* run(fallbackUrl);
      if (!shouldUseFallbackEndpoint(resp.status)) return resp;
      yield* Effect.promise(() => resp.body?.cancel() ?? Promise.resolve());
      return yield* postPrimary(router, provider, primary, run);
    }

    const resp = yield* postPrimary(router, provider, primary, run);
    if (!shouldUseFallbackEndpoint(resp.status)) return resp;
    yield* Effect.promise(() => resp.body?.cancel() ?? Promise.resolve());
    yield* router.recordStrike(provider);
    return yield* run(fallbackUrl);
  }).pipe(Effect.mapError((cause) => fallbackFailure(provider, cause)));
}

export function postJSONWithFallback(
  provider: string,
  fetchFn: FetchLike,
  state: FallbackState | null,
  url: string,
  fallbackUrl: string,
  bearer: string,
  payload: unknown,
  stream: boolean,
  headers?: Record<string, string>,
  onStart?: () => void
): Effect.Effect<Response, ProviderFallbackFailure> {
  return postExecuteWithFallback(fetchFn, state, provider, url, fallbackUrl, (fn, target) =>
    postJSONWithHeaders(provider, fn, target, bearer, payload, stream, headers, onStart)
  );
}

function postPrimary(
  router: FallbackState,
  provider: string,
  primary: string,
  poster: (target: string) => Effect.Effect<Response, ProviderTransportFailure>
): Effect.Effect<Response, ProviderTransportFailure> {
  return poster(primary).pipe(
    Effect.tap((resp) =>
      resp.status >= 200 && resp.status < 300 ? router.clear(provider) : Effect.void
    )
  );
}

export function postWithEgressFallback(options: {
  transport: UpstreamTransport;
  state: FallbackState | null;
  provider: string;
  primary: string;
  execute: (fetchFn: FetchLike, url: string) => Effect.Effect<Response, ProviderTransportFailure>;
  logger?: Logger;
  retry?: Partial<EgressRetryPolicy>;
}): Effect.Effect<Response, ProviderFallbackFailure> {
  const { transport, provider, primary, execute } = options;
  const router = options.state ?? new NoFallbackState();
  const egressFetch = transport.egress;
  const egressAvailable = transport.egressReady() && egressFetch !== null;

  if (!egressAvailable) {
    return postPrimary(router, provider, primary, (target) => execute(transport.direct, target)).pipe(
      Effect.mapError((cause) => fallbackFailure(provider, cause))
    );
  }

  return Effect.gen(function* () {
    if (yield* router.sticky(provider)) {
      options.logger?.("egress preferred", { provider });
      const resp = yield* postEgressWithRotation(options, primary, transport);
      if (!shouldUseFallbackEndpoint(resp.status)) return resp;
      yield* Effect.promise(() => resp.body?.cancel() ?? Promise.resolve());
      return yield* postPrimary(router, provider, primary, (target) => execute(transport.direct, target));
    }

    const resp = yield* postPrimary(router, provider, primary, (target) =>
      execute(transport.direct, target)
    );
    if (!shouldUseFallbackEndpoint(resp.status)) return resp;
    options.logger?.("egress fallback", { provider, status: resp.status });
    yield* Effect.promise(() => resp.body?.cancel() ?? Promise.resolve());
    yield* router.recordStrike(provider);
    return yield* postEgressWithRotation(options, primary, transport);
  }).pipe(Effect.mapError((cause) => fallbackFailure(provider, cause)));
}

function postEgressWithRotation(
  options: {
    provider: string;
    execute: (fetchFn: FetchLike, url: string) => Effect.Effect<Response, ProviderTransportFailure>;
    logger?: Logger;
    retry?: Partial<EgressRetryPolicy>;
  },
  primary: string,
  transport: UpstreamTransport
): Effect.Effect<Response, ProviderTransportFailure> {
  const egressFetch = transport.egress as EgressFetch;
  const policy: EgressRetryPolicy = { ...DEFAULT_EGRESS_RETRY, ...options.retry };
  const attemptsFor = (status: number): number => {
    if (status === 403) return Math.max(1, policy.forbidden);
    if (status === 429) return Math.max(1, policy.limited);
    return 1;
  };

  const attemptOnce = options.execute(egressFetch, primary);

  const loop = (attempt: number): Effect.Effect<Response, ProviderTransportFailure> =>
    attemptOnce.pipe(
      Effect.flatMap((response) => {
        if (!shouldUseFallbackEndpoint(response.status)) return Effect.succeed(response);
        if (attempt + 1 >= attemptsFor(response.status)) return Effect.succeed(response);
        return Effect.promise(() => response.body?.cancel() ?? Promise.resolve()).pipe(
          Effect.flatMap(() =>
            Effect.logDebug("egress retry", {
              provider: options.provider,
              attempt: attempt + 1,
              status: response.status,
            })
          ),
          Effect.flatMap(() => Effect.sleep(Duration.millis(Math.min(50 * 2 ** attempt, 2000)))),
          Effect.flatMap(() => loop(attempt + 1))
        );
      }),
      Effect.catchTag("ProviderTransportFailure", (error) =>
        attempt + 1 >= Math.max(1, policy.transport) ? Effect.fail(error) : loop(attempt + 1)
      )
    );

  return loop(0);
}

export function postJSONWithEgressFallback(
  transport: UpstreamTransport,
  state: FallbackState | null,
  provider: string,
  url: string,
  bearer: string,
  payload: unknown,
  stream: boolean,
  headers?: Record<string, string>,
  onStart?: () => void,
  logger?: Logger
): Effect.Effect<Response, ProviderFallbackFailure> {
  return postWithEgressFallback({
    transport,
    state,
    provider,
    primary: url,
    logger,
    execute: (fetchFn, target) =>
      postJSONWithHeaders(provider, fetchFn, target, bearer, payload, stream, headers, onStart),
  });
}

export function statusOf(resp: Response | null | undefined): number {
  return resp ? resp.status : 0;
}

export type {
  ProviderCredentialFailure,
  ProviderFallbackFailure,
  ProviderFailure,
  ProviderRequestFailure,
  ProviderTransportFailure,
  QuotaFailure,
  QuotaFetchFailure,
  QuotaJournalFailure,
} from "./errors.js";
