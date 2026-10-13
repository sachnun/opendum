import { Effect } from "effect";
import type { OpendumRedis } from "@opendum/core/redis";

const FALLBACK_STICKY_PREFIX = "opendum:provider:fallback";
const FALLBACK_STRIKE_PREFIX = "opendum:provider:fallback-strikes";
const FALLBACK_STICKY_TTL_SECONDS = 10 * 60;
const FALLBACK_STRIKE_WINDOW_SECONDS = 5 * 60;
const FALLBACK_STRIKE_LIMIT = 2;

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

export function fallbackStickyKey(provider: string): string {
  return `${FALLBACK_STICKY_PREFIX}:${provider}`;
}

export function fallbackStrikeKey(provider: string): string {
  return `${FALLBACK_STRIKE_PREFIX}:${provider}`;
}

export class RedisFallbackRouter implements FallbackState {
  private readonly redis: OpendumRedis;

  constructor(redis: OpendumRedis) {
    this.redis = redis;
  }

  sticky(provider: string): Effect.Effect<boolean> {
    if (!provider) return Effect.succeed(false);
    return Effect.tryPromise({
      try: async () => (await this.redis.exists(fallbackStickyKey(provider))) > 0,
      catch: (cause) => cause,
    }).pipe(Effect.orElseSucceed(() => false));
  }

  recordStrike(provider: string): Effect.Effect<void> {
    if (!provider) return Effect.void;
    return Effect.tryPromise({
      try: async () => {
        const strikeKey = fallbackStrikeKey(provider);
        const count = await this.redis.incr(strikeKey);
        if (count === 1) {
          await this.redis.expire(strikeKey, FALLBACK_STRIKE_WINDOW_SECONDS);
        }
        if (count < FALLBACK_STRIKE_LIMIT) return;
        await this.redis.set(fallbackStickyKey(provider), "1", { EX: FALLBACK_STICKY_TTL_SECONDS });
        await this.redis.del(strikeKey);
      },
      catch: (cause) => cause,
    }).pipe(Effect.ignore);
  }

  clear(provider: string): Effect.Effect<void> {
    if (!provider) return Effect.void;
    return Effect.tryPromise({
      try: () => this.redis.del([fallbackStickyKey(provider), fallbackStrikeKey(provider)]),
      catch: (cause) => cause,
    }).pipe(Effect.ignore);
  }
}

export type EndpointPoster = (url: string) => Effect.Effect<Response, unknown>;

export function shouldUseFallbackEndpoint(status: number): boolean {
  return status === 403 || status === 429;
}

export function postWithFallback(
  state: FallbackState | null,
  provider: string,
  primary: string,
  fallback: string,
  post: EndpointPoster
): Effect.Effect<Response, unknown> {
  const router = state ?? new NoFallbackState();
  if (!fallback) return post(primary);

  return Effect.gen(function* () {
    if (yield* router.sticky(provider)) {
      const resp = yield* post(fallback);
      if (!shouldUseFallbackEndpoint(resp.status)) return resp;
      yield* Effect.promise(() => resp.body?.cancel() ?? Promise.resolve());
      return yield* postPrimary(router, provider, primary, post);
    }

    const resp = yield* postPrimary(router, provider, primary, post);
    if (!shouldUseFallbackEndpoint(resp.status)) return resp;
    yield* Effect.promise(() => resp.body?.cancel() ?? Promise.resolve());
    yield* router.recordStrike(provider);
    return yield* post(fallback);
  });
}

function postPrimary(
  router: FallbackState,
  provider: string,
  primary: string,
  post: EndpointPoster
): Effect.Effect<Response, unknown> {
  return post(primary).pipe(
    Effect.tap((resp) =>
      resp.status >= 200 && resp.status < 300 ? router.clear(provider) : Effect.void
    )
  );
}
