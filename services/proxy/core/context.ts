import { Effect, Layer } from "effect";
import { AuthService } from "@opendum/auth";
import { closeRedis, openRedis } from "@opendum/core/redis";
import { resolveModelsDir } from "@opendum/models";
import { Registry as ModelRegistry } from "@opendum/models/runtime";
import { GuardedFetcher, UnroxyEgress, type GuardedFetch } from "@opendum/core/egress";
import { ProviderRegistry, RedisFallbackRouter, type EgressFetch } from "@opendum/providers";
import { db, closeDatabase } from "@opendum/database";
import { ProxyService } from "./service.js";
import { proxyConfig } from "../config.js";
import { ProxyContextTag, type ProxyContext } from "./services.js";
import { tryAsync } from "./helpers.js";

export type { ProxyContext } from "./services.js";

async function resolveModelsDirForService(): Promise<string> {
  const cwd = process.cwd();
  const candidates = [
    `${cwd}/../../packages/models/data`,
    `${cwd}/packages/models/data`,
    "/app/packages/models/data",
  ];
  for (const candidate of candidates) {
    const normalized = Bun.fileURLToPath(new URL(candidate, "file:///"));
    const stats = await tryAsync(() => Bun.file(normalized).stat(), null);
    if (stats?.isDirectory()) return normalized;
  }
  return resolveModelsDir();
}

export const ProxyContextLayer = Layer.effect(
  ProxyContextTag,
  Effect.gen(function* () {
    const config = yield* proxyConfig;
    const dir = yield* Effect.promise(() => resolveModelsDirForService());
    const models = yield* Effect.sync(() => ModelRegistry.load(dir));
    const redis = yield* Effect.acquireRelease(
      Effect.promise(() => openRedis(config.redisUrl)),
      (client) => Effect.promise(() => closeRedis(client))
    );
    const auth = new AuthService(models, redis);
    const egress = yield* Effect.acquireRelease(
      Effect.sync(() => new UnroxyEgress()),
      (value) => Effect.promise(() => value.close())
    );
    const guard = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new GuardedFetcher({
            headersTimeout: config.requestTimeoutMs > 0 ? config.requestTimeoutMs : undefined,
          })
      ),
      (fetcher) => Effect.promise(() => fetcher.close())
    );
    const guardedFetch: GuardedFetch = (url, init) => guard.fetch(url, init);
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
    });

    if (config.tokenRefreshIntervalMs > 0) {
      yield* Effect.forkScoped(
        service.refreshTokenLoop(config.tokenRefreshIntervalMs).pipe(Effect.catchCause(() => Effect.void))
      );
    }

    yield* Effect.addFinalizer(() => Effect.promise(() => closeDatabase()));

    const context: ProxyContext = { config, models, redis, auth, providers, service, egress, guardedFetch };
    return context;
  })
);
