import { existsSync } from "node:fs";
import { Effect, Layer } from "effect";
import { AuthService } from "@opendum/auth";
import { closeRedis, openRedis } from "@opendum/platform/redis";
import { modelsDir } from "@opendum/models";
import { tryLoad } from "@opendum/models/runtime";
import { Fetcher, UnroxyEgress, type Fetch } from "@opendum/platform/egress";
import { ProviderRegistry, RedisFallbackRouter, type EgressFetch } from "@opendum/providers";
import { db, closeDatabase } from "@opendum/database";
import { ProxyService } from "@opendum/api/proxy/service";
import { reconcileOrphans, reconcileLoop } from "@opendum/api/proxy/roaming-reconcile";
import { proxyConfig } from "@opendum/api/config";
import { ProxyContextTag, type ProxyContext } from "@opendum/api/proxy/services";

export type { ProxyContext } from "@opendum/api/proxy/services";

export function dirFor(): string {
  const cwd = process.cwd();
  const candidates = [
    `${cwd}/../../packages/models/data`,
    `${cwd}/packages/models/data`,
    "/app/packages/models/data",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return modelsDir();
}

export const ProxyContextLayer = Layer.effect(
  ProxyContextTag,
  Effect.gen(function* () {
    const config = yield* proxyConfig;
    const dir = yield* Effect.sync(() => dirFor());
    const models = yield* tryLoad(dir);
    const redis = yield* Effect.acquireRelease(
      Effect.promise(() => openRedis(config.redisUrl)),
      (client) => Effect.promise(() => closeRedis(client))
    );
    const auth = new AuthService(models, redis);
    const egress = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new UnroxyEgress({
            headersTimeout: config.requestTimeoutMs > 0 ? config.requestTimeoutMs : undefined,
          })
      ),
      (value) => Effect.promise(() => value.close())
    );
    const guard = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new Fetcher({
            headersTimeout: config.requestTimeoutMs > 0 ? config.requestTimeoutMs : undefined,
          })
      ),
      (fetcher) => Effect.orDie(fetcher.close())
    );
    const guardedFetch: Fetch = (url, init) => Effect.runPromise(guard.fetch(url, init));
    const directFetch = (url: string, init?: RequestInit): Promise<Response> =>
      Effect.runPromise(
        Effect.tryPromise({
          try: () => guardedFetch(url, init),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        })
      );
    const providers = new ProviderRegistry({
      models,
      fallback: new RedisFallbackRouter(redis),
      redis,
      directFetch,
    });
    const egressFetch: EgressFetch = (url, init) => egress.fetch(url, init);
    providers.setEgress(egressFetch, true);
    const service = new ProxyService({
      database: db,
      redis,
      models,
      auth,
      providers,
      betterAuthSecret: config.betterAuthSecret,
      requestTimeoutMs: config.requestTimeoutMs,
      streamTimeoutMs: config.streamTimeoutMs,
      streamHeartbeatMs: config.streamHeartbeatMs,
    });

    if (config.tokenRefreshIntervalMs > 0) {
      yield* Effect.forkScoped(
        service.refreshTokenLoop(config.tokenRefreshIntervalMs).pipe(Effect.catchCause(() => Effect.void))
      );
    }

    if (config.roamingReconcileIntervalMs > 0) {
      yield* Effect.forkScoped(
        reconcileLoop(config.roamingReconcileIntervalMs, () =>
          reconcileOrphans(service.points)
        ).pipe(Effect.catchCause(() => Effect.void))
      );
    }

    yield* Effect.addFinalizer(() => Effect.promise(() => closeDatabase()));

    const context: ProxyContext = { config, models, redis, auth, providers, service, egress, guardedFetch };
    return context;
  })
);
