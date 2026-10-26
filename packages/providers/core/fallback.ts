import { Effect } from "effect";
import type { OpendumRedis } from "@opendum/core/redis";

const STICKY_PREFIX = "opendum:provider:fallback";
const STRIKE_PREFIX = "opendum:provider:fallback-strikes";
const STICKY_TTL_SECONDS = 10 * 60;
const STRIKE_WINDOW_SECONDS = 5 * 60;
const STRIKE_LIMIT = 2;

const stickyKey = (provider: string): string => `${STICKY_PREFIX}:${provider}`;
const strikeKey = (provider: string): string => `${STRIKE_PREFIX}:${provider}`;

export type EndpointPoster = (url: string) => Effect.Effect<Response, unknown>;

export interface FallbackState {
  sticky(provider: string): Effect.Effect<boolean>;
  recordStrike(provider: string): Effect.Effect<void>;
  clear(provider: string): Effect.Effect<void>;
}

export class NoFallbackState implements FallbackState {
  sticky(): Effect.Effect<boolean> {
    return Effect.succeed(false);
  }

  recordStrike(): Effect.Effect<void> {
    return Effect.void;
  }

  clear(): Effect.Effect<void> {
    return Effect.void;
  }
}

export class RedisFallbackRouter implements FallbackState {
  private readonly redis: OpendumRedis;

  constructor(redis: OpendumRedis) {
    this.redis = redis;
  }

  sticky(provider: string): Effect.Effect<boolean> {
    if (!provider) return Effect.succeed(false);
    return Effect.tryPromise({
      try: async () => (await this.redis.exists(stickyKey(provider))) > 0,
      catch: (cause) => cause,
    }).pipe(Effect.orElseSucceed(() => false));
  }

  recordStrike(provider: string): Effect.Effect<void> {
    if (!provider) return Effect.void;
    return Effect.tryPromise({
      try: async () => {
        const key = strikeKey(provider);
        const count = await this.redis.incr(key);
        if (count === 1) {
          await this.redis.expire(key, STRIKE_WINDOW_SECONDS);
        }
        if (count < STRIKE_LIMIT) return;
        await this.redis.set(stickyKey(provider), "1", { EX: STICKY_TTL_SECONDS });
        await this.redis.del(key);
      },
      catch: (cause) => cause,
    }).pipe(Effect.ignore);
  }

  clear(provider: string): Effect.Effect<void> {
    if (!provider) return Effect.void;
    return Effect.tryPromise({
      try: () => this.redis.del([stickyKey(provider), strikeKey(provider)]),
      catch: (cause) => cause,
    }).pipe(Effect.ignore);
  }
}

export class FallbackPolicy {
  readonly state: FallbackState;

  constructor(state: FallbackState | null) {
    this.state = state ?? new NoFallbackState();
  }

  static triggers(status: number): boolean {
    return status === 403 || status === 429;
  }

  sticky(provider: string): Effect.Effect<boolean> {
    return this.state.sticky(provider);
  }

  recordStrike(provider: string): Effect.Effect<void> {
    return this.state.recordStrike(provider);
  }

  clear(provider: string): Effect.Effect<void> {
    return this.state.clear(provider);
  }

  primary<A extends { status: number }>(
    provider: string,
    run: Effect.Effect<A, unknown>
  ): Effect.Effect<A, unknown> {
    return run.pipe(
      Effect.tap((resp) =>
        resp.status >= 200 && resp.status < 300 ? this.state.clear(provider) : Effect.void
      )
    );
  }

  post(
    provider: string,
    primary: string,
    fallback: string,
    post: EndpointPoster
  ): Effect.Effect<Response, unknown> {
    if (!fallback) return post(primary);

    return Effect.gen({ self: this }, function* () {
      if (yield* this.sticky(provider)) {
        const resp = yield* post(fallback);
        if (!FallbackPolicy.triggers(resp.status)) return resp;
        yield* Effect.promise(() => resp.body?.cancel() ?? Promise.resolve());
        return yield* this.primary(provider, post(primary));
      }

      const resp = yield* this.primary(provider, post(primary));
      if (!FallbackPolicy.triggers(resp.status)) return resp;
      yield* Effect.promise(() => resp.body?.cancel() ?? Promise.resolve());
      yield* this.recordStrike(provider);
      return yield* post(fallback);
    });
  }
}
