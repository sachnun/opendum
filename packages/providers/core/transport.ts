import { Duration, Effect, Schedule } from "effect";
import { FallbackPolicy, type FallbackState } from "@opendum/providers/core/fallback";
import { JSONPoster, RequestFailure, type EgressFetch, type FetchLike, type PostOptions } from "@opendum/providers/core/request";
import type { ProviderFallbackFailure, ProviderTransportFailure } from "@opendum/providers/core/errors";

export type UpstreamTransport = {
  readonly direct: FetchLike;
  readonly egress: EgressFetch | null;
  egressReady(): boolean;
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

export type FallbackPostOptions = {
  provider: string;
  fetchFn: FetchLike;
  state: FallbackState | null;
  primary: string;
  fallback: string;
  execute: (fetchFn: FetchLike, url: string) => Effect.Effect<Response, ProviderTransportFailure>;
};

export type EgressPostOptions = {
  transport: UpstreamTransport;
  state: FallbackState | null;
  provider: string;
  primary: string;
  execute: (fetchFn: FetchLike, url: string) => Effect.Effect<Response, ProviderTransportFailure>;
  logger?: Logger;
  retry?: Partial<EgressRetryPolicy>;
};

export type EgressJSONOptions = Omit<PostOptions, "fetchFn"> & {
  transport: UpstreamTransport;
  state: FallbackState | null;
  logger?: Logger;
};

export class Retry {
  static transient<A, E, R>(
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
}

export class Transport {
  readonly direct: FetchLike;

  private egressFetch: EgressFetch | null = null;

  private egressReadyFlag = false;

  constructor(direct: FetchLike) {
    this.direct = direct;
  }

  get egress(): EgressFetch | null {
    return this.egressFetch;
  }

  egressReady(): boolean {
    return this.egressFetch !== null && this.egressReadyFlag;
  }

  setEgress(egress: EgressFetch | null, ready: boolean): void {
    this.egressFetch = egress;
    this.egressReadyFlag = ready;
  }
}

export class FallbackPoster {
  private readonly policy: FallbackPolicy;

  constructor(state: FallbackState | null) {
    this.policy = new FallbackPolicy(state);
  }

  send(options: FallbackPostOptions): Effect.Effect<Response, ProviderFallbackFailure> {
    const run = (target: string): Effect.Effect<Response, ProviderTransportFailure> =>
      options.execute(options.fetchFn, target);

    return this.policy
      .post(options.provider, options.primary, options.fallback, run)
      .pipe(Effect.mapError((cause) => RequestFailure.fallback(options.provider, cause)));
  }
}

export class EgressPoster {
  private readonly policy: FallbackPolicy;

  private readonly options: EgressPostOptions;

  constructor(options: EgressPostOptions) {
    this.options = options;
    this.policy = new FallbackPolicy(options.state);
  }

  private direct(): (target: string) => Effect.Effect<Response, ProviderTransportFailure> {
    return (target) => this.options.execute(this.options.transport.direct, target);
  }

  private rotate(): Effect.Effect<Response, ProviderTransportFailure> {
    const egressFetch = this.options.transport.egress as EgressFetch;
    const policy: EgressRetryPolicy = { ...DEFAULT_EGRESS_RETRY, ...this.options.retry };
    const attemptsFor = (status: number): number => {
      if (status === 403) return Math.max(1, policy.forbidden);
      if (status === 429) return Math.max(1, policy.limited);
      return 1;
    };

    const attemptOnce = this.options.execute(egressFetch, this.options.primary);

    const loop = (attempt: number): Effect.Effect<Response, ProviderTransportFailure> =>
      attemptOnce.pipe(
        Effect.flatMap((response) => {
          if (!FallbackPolicy.triggers(response.status)) return Effect.succeed(response);
          if (attempt + 1 >= attemptsFor(response.status)) return Effect.succeed(response);
          return Effect.promise(async () => {
            await response.body?.cancel();
          }).pipe(
            Effect.flatMap(() =>
              Effect.logDebug("egress retry", {
                provider: this.options.provider,
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

  send(): Effect.Effect<Response, ProviderFallbackFailure> {
    const { transport, provider, primary } = this.options;
    const egressAvailable = transport.egressReady() && transport.egress !== null;

    if (!egressAvailable) {
      return this.policy
        .primary(provider, this.direct()(primary))
        .pipe(Effect.mapError((cause) => RequestFailure.fallback(provider, cause)));
    }

    return Effect.gen({ self: this }, function* () {
      if (yield* this.policy.sticky(provider)) {
        this.options.logger?.("egress preferred", { provider });
        const resp = yield* this.rotate();
        if (!FallbackPolicy.triggers(resp.status)) return resp;
        yield* Effect.promise(async () => {
        await resp.body?.cancel();
      });
        return yield* this.policy.primary(provider, this.direct()(primary));
      }

      const resp = yield* this.policy.primary(provider, this.direct()(primary));
      if (!FallbackPolicy.triggers(resp.status)) return resp;
      this.options.logger?.("egress fallback", { provider, status: resp.status });
      yield* Effect.promise(async () => {
        await resp.body?.cancel();
      });
      yield* this.policy.recordStrike(provider);
      return yield* this.rotate();
    }).pipe(Effect.mapError((cause) => RequestFailure.fallback(provider, cause)));
  }
}

export class EgressJSONPoster {
  static send(options: EgressJSONOptions): Effect.Effect<Response, ProviderFallbackFailure> {
    return new EgressPoster({
      transport: options.transport,
      state: options.state,
      provider: options.provider,
      primary: options.url,
      logger: options.logger,
      execute: (fetchFn, target) =>
        JSONPoster.withAuth({
          provider: options.provider,
          fetchFn,
          url: target,
          bearer: options.bearer,
          payload: options.payload,
          stream: options.stream,
          headers: options.headers,
          onStart: options.onStart,
        }),
    }).send();
  }
}
