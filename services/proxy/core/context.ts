import { Effect, Layer } from "effect";
import { AuthService } from "@opendum/auth";
import { closeRedis, openRedis } from "@opendum/core/redis";
import { resolveModelsDir } from "@opendum/models";
import { Registry as ModelRegistry } from "@opendum/models/runtime";
import { UnroxyEgress, assertPublicHost, createGuardedFetch, type GuardedFetch } from "@opendum/core/egress";
import { ProviderRegistry, RedisFallbackRouter, type EgressFetch } from "@opendum/providers";
import { db, closeDatabase } from "@opendum/database";
import { ProxyService } from "./service.js";
import { proxyConfig } from "../config.js";
import { ProxyContextTag, type ProxyContext } from "./services.js";

export type { ProxyContext } from "./services.js";

const MAX_REDIRECTS = 10;

async function resolveModelsDirForService(): Promise<string> {
  const cwd = process.cwd();
  const candidates = [
    `${cwd}/../../packages/models/data`,
    `${cwd}/packages/models/data`,
    "/app/packages/models/data",
  ];
  for (const candidate of candidates) {
    const normalized = Bun.fileURLToPath(new URL(candidate, "file:///"));
    try {
      const stats = await Bun.file(normalized).stat();
      if (stats.isDirectory()) return normalized;
    } catch {
      continue;
    }
  }
  return resolveModelsDir();
}

async function fetchThroughRedirects(
  baseFetch: GuardedFetch,
  url: string,
  init?: RequestInit
): Promise<Response> {
  let current = url;
  let currentInit = init;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const parsed = new URL(current);
    assertPublicHost(parsed.hostname);
    const response = await baseFetch(current, { ...currentInit, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    await response.body?.cancel().catch(() => undefined);
    if (hop === MAX_REDIRECTS) throw new Error("stopped after 10 redirects");
    const next = new URL(location, current);
    if (next.protocol !== "https:") throw new Error("redirect must use https");
    const method = (currentInit?.method ?? "GET").toUpperCase();
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== "GET" && method !== "HEAD")) {
      currentInit = { ...currentInit, method: "GET", body: undefined };
    }
    current = next.toString();
  }
  throw new Error("stopped after 10 redirects");
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
      Effect.sync(() =>
        createGuardedFetch({ headersTimeout: config.requestTimeoutMs > 0 ? config.requestTimeoutMs : undefined })
      ),
      (fetcher) => Effect.promise(() => fetcher.close())
    );
    const guardedFetch: GuardedFetch = (url, init) => fetchThroughRedirects(guard.fetch, url, init);
    const directFetch = (url: string, init?: RequestInit): Promise<Response> =>
      guardedFetch(url, init).catch((error: unknown) =>
        Promise.reject(error instanceof Error ? error : new Error(String(error)))
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

export { fetchThroughRedirects };
