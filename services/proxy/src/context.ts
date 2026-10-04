import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { AuthService } from "@opendum/auth";
import { closeRedis, openRedis, type OpendumRedis } from "@opendum/redis";
import { resolveModelsDir } from "@opendum/models";
import { Registry as ModelRegistry } from "@opendum/models/runtime";
import { UnroxyEgress, assertPublicHost, createGuardedFetch, type GuardedFetch } from "@opendum/egress";
import { ProviderRegistry, RedisFallbackRouter, type EgressFetch } from "@opendum/providers";
import { db } from "@opendum/database";
import type { ProxyConfig } from "./config.js";
import { ProxyService } from "./core/service.js";

export type ProxyContext = {
  config: ProxyConfig;
  models: ModelRegistry;
  redis: OpendumRedis;
  auth: AuthService;
  providers: ProviderRegistry;
  service: ProxyService;
  egress: UnroxyEgress;
  guardedFetch: GuardedFetch;
  closeDirect: () => Promise<void>;
};

function resolveModelsDirForService(): string {
  const candidates = [
    resolve(process.cwd(), "../../packages/models/data"),
    resolve(process.cwd(), "packages/models/data"),
    "/app/packages/models/data",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return resolveModelsDir();
}

const MAX_REDIRECTS = 10;

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

export async function createContext(config: ProxyConfig): Promise<ProxyContext> {
  const models = ModelRegistry.load(resolveModelsDirForService());
  const redis = await openRedis(config.redisUrl);
  const auth = new AuthService(models, redis);

  const egress = new UnroxyEgress();
  const guard = createGuardedFetch({
    headersTimeout: config.requestTimeoutMs > 0 ? config.requestTimeoutMs : undefined,
  });
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

  return { config, models, redis, auth, providers, service, egress, guardedFetch, closeDirect: () => guard.close() };
}

export async function disposeContext(context: ProxyContext): Promise<void> {
  await context.egress.close();
  await context.closeDirect();
  await closeRedis(context.redis);
}
