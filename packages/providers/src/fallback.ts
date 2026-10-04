import type { OpendumRedis } from "@opendum/redis";

const FALLBACK_STICKY_PREFIX = "opendum:provider:fallback";
const FALLBACK_STRIKE_PREFIX = "opendum:provider:fallback-strikes";
const FALLBACK_STICKY_TTL_SECONDS = 10 * 60;
const FALLBACK_STRIKE_WINDOW_SECONDS = 5 * 60;
const FALLBACK_STRIKE_LIMIT = 2;

export interface FallbackState {
  sticky(provider: string): Promise<boolean>;
  recordStrike(provider: string): Promise<void>;
  clear(provider: string): Promise<void>;
}

export class NoFallbackState implements FallbackState {
  async sticky(): Promise<boolean> {
    return false;
  }
  async recordStrike(): Promise<void> {
    return;
  }
  async clear(): Promise<void> {
    return;
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

  async sticky(provider: string): Promise<boolean> {
    if (!provider) return false;
    try {
      return (await this.redis.exists(fallbackStickyKey(provider))) > 0;
    } catch {
      return false;
    }
  }

  async recordStrike(provider: string): Promise<void> {
    if (!provider) return;
    try {
      const strikeKey = fallbackStrikeKey(provider);
      const count = await this.redis.incr(strikeKey);
      if (count === 1) {
        await this.redis.expire(strikeKey, FALLBACK_STRIKE_WINDOW_SECONDS);
      }
      if (count < FALLBACK_STRIKE_LIMIT) return;
      await this.redis.set(fallbackStickyKey(provider), "1", { EX: FALLBACK_STICKY_TTL_SECONDS });
      await this.redis.del(strikeKey);
    } catch {
      return;
    }
  }

  async clear(provider: string): Promise<void> {
    if (!provider) return;
    try {
      await this.redis.del([fallbackStickyKey(provider), fallbackStrikeKey(provider)]);
    } catch {
      return;
    }
  }
}

export type EndpointPoster = (url: string) => Promise<Response>;

export function shouldUseFallbackEndpoint(status: number): boolean {
  return status === 403 || status === 429;
}

export async function postWithFallback(
  state: FallbackState | null,
  provider: string,
  primary: string,
  fallback: string,
  post: EndpointPoster
): Promise<Response> {
  const router = state ?? new NoFallbackState();
  if (!fallback) return post(primary);

  if (await router.sticky(provider)) {
    const resp = await post(fallback);
    if (!shouldUseFallbackEndpoint(resp.status)) return resp;
    await resp.body?.cancel();
    return postPrimary(router, provider, primary, post);
  }

  const resp = await postPrimary(router, provider, primary, post);
  if (!shouldUseFallbackEndpoint(resp.status)) return resp;

  await resp.body?.cancel();
  await router.recordStrike(provider);
  return post(fallback);
}

async function postPrimary(
  router: FallbackState,
  provider: string,
  primary: string,
  post: EndpointPoster
): Promise<Response> {
  const resp = await post(primary);
  if (resp.status >= 200 && resp.status < 300) {
    await router.clear(provider);
  }
  return resp;
}
