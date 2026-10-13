import { Duration, Effect } from "effect";
import type { FallbackState } from "./fallback.js";
import { NoFallbackState, shouldUseFallbackEndpoint } from "./fallback.js";

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

export async function postJSONWithHeadersAuth(
  fetchFn: FetchLike,
  url: string,
  bearer: string,
  payload: unknown,
  stream: boolean,
  extraHeaders?: Record<string, string>,
  useAuth = true,
  onStart?: () => void
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (useAuth) headers.Authorization = `Bearer ${bearer.trim()}`;
  headers.Accept = stream ? "text/event-stream" : "application/json";
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) headers[key] = value;
  }
  const resp = await fetchFn(url, { method: "POST", headers, body: JSON.stringify(payload) });
  onStart?.();
  return resp;
}

export function postJSON(
  fetchFn: FetchLike,
  url: string,
  bearer: string,
  payload: unknown,
  stream: boolean,
  onStart?: () => void
): Promise<Response> {
  return postJSONWithHeadersAuth(fetchFn, url, bearer, payload, stream, undefined, true, onStart);
}

export function postJSONWithHeaders(
  fetchFn: FetchLike,
  url: string,
  bearer: string,
  payload: unknown,
  stream: boolean,
  extraHeaders?: Record<string, string>,
  onStart?: () => void
): Promise<Response> {
  return postJSONWithHeadersAuth(fetchFn, url, bearer, payload, stream, extraHeaders, true, onStart);
}

export function postJSONWithoutAuth(
  fetchFn: FetchLike,
  url: string,
  payload: unknown,
  stream: boolean,
  onStart?: () => void
): Promise<Response> {
  return postJSONWithHeadersAuth(fetchFn, url, "", payload, stream, undefined, false, onStart);
}

export async function postExecuteWithFallback(
  fetchFn: FetchLike,
  state: FallbackState | null,
  provider: string,
  primary: string,
  fallbackUrl: string,
  execute: (fetchFn: FetchLike, url: string) => Promise<Response>
): Promise<Response> {
  const router = state ?? new NoFallbackState();
  const run = (target: string): Promise<Response> => execute(fetchFn, target);
  if (!fallbackUrl) return run(primary);

  if (await router.sticky(provider)) {
    const resp = await run(fallbackUrl);
    if (!shouldUseFallbackEndpoint(resp.status)) return resp;
    await resp.body?.cancel();
    return postPrimary(router, provider, primary, run);
  }

  const resp = await postPrimary(router, provider, primary, run);
  if (!shouldUseFallbackEndpoint(resp.status)) return resp;
  await resp.body?.cancel();
  await router.recordStrike(provider);
  return run(fallbackUrl);
}

export function postJSONWithFallback(
  fetchFn: FetchLike,
  state: FallbackState | null,
  provider: string,
  url: string,
  fallbackUrl: string,
  bearer: string,
  payload: unknown,
  stream: boolean,
  headers?: Record<string, string>,
  onStart?: () => void
): Promise<Response> {
  return postExecuteWithFallback(fetchFn, state, provider, url, fallbackUrl, (fn, target) =>
    postJSONWithHeaders(fn, target, bearer, payload, stream, headers, onStart)
  );
}

async function postPrimary(
  router: FallbackState,
  provider: string,
  primary: string,
  poster: (target: string) => Promise<Response>
): Promise<Response> {
  const resp = await poster(primary);
  if (resp.status >= 200 && resp.status < 300) await router.clear(provider);
  return resp;
}

export async function postWithEgressFallback(options: {
  transport: UpstreamTransport;
  state: FallbackState | null;
  provider: string;
  primary: string;
  execute: (fetchFn: FetchLike, url: string) => Promise<Response>;
  logger?: Logger;
}): Promise<Response> {
  const { transport, provider, primary, execute } = options;
  const router = options.state ?? new NoFallbackState();
  const egressFetch = transport.egress;
  const egressAvailable = transport.egressReady() && egressFetch !== null;

  if (!egressAvailable) {
    return postPrimary(router, provider, primary, (target) => execute(transport.direct, target));
  }

  if (await router.sticky(provider)) {
    options.logger?.("egress preferred", { provider });
    const resp = await postEgressWithRotation(options, primary, transport);
    if (!shouldUseFallbackEndpoint(resp.status)) return resp;
    await resp.body?.cancel();
    return postPrimary(router, provider, primary, (target) => execute(transport.direct, target));
  }

  const resp = await postPrimary(router, provider, primary, (target) => execute(transport.direct, target));
  if (!shouldUseFallbackEndpoint(resp.status)) return resp;
  options.logger?.("egress fallback", { provider, status: resp.status });
  await resp.body?.cancel();
  await router.recordStrike(provider);
  return postEgressWithRotation(options, primary, transport);
}

async function postEgressWithRotation(
  options: {
    provider: string;
    execute: (fetchFn: FetchLike, url: string) => Promise<Response>;
    logger?: Logger;
  },
  primary: string,
  transport: UpstreamTransport
): Promise<Response> {
  const egressFetch = transport.egress as EgressFetch;

  const attemptOnce = Effect.tryPromise({
    try: () => options.execute(egressFetch, primary),
    catch: (error) => error,
  });

  const loop = (attempt: number): Effect.Effect<Response, unknown> =>
    attemptOnce.pipe(
      Effect.flatMap((response) => {
        if (!shouldUseFallbackEndpoint(response.status)) return Effect.succeed(response);
        const maxTries = response.status === 403 ? EGRESS_FORBIDDEN_TRIES : EGRESS_MAX_TRIES;
        if (attempt + 1 >= maxTries) return Effect.succeed(response);
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
      Effect.catch((error) => (attempt + 1 >= EGRESS_MAX_TRIES ? Effect.fail(error) : loop(attempt + 1)))
    );

  return Effect.runPromise(loop(0));
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
): Promise<Response> {
  return postWithEgressFallback({
    transport,
    state,
    provider,
    primary: url,
    logger,
    execute: (fetchFn, target) =>
      postJSONWithHeaders(fetchFn, target, bearer, payload, stream, headers, onStart),
  });
}

export function statusOf(resp: Response | null | undefined): number {
  return resp ? resp.status : 0;
}
