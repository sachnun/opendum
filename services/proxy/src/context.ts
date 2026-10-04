import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { AuthService } from "@opendum/auth";
import { closeRedis, openRedis, type OpendumRedis } from "@opendum/redis";
import { resolveModelsDir } from "@opendum/models";
import { Registry as ModelRegistry } from "@opendum/models/runtime";
import { UnroxyEgress, assertPublicHost } from "@opendum/egress";
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
};

function resolveModelsDirForService(): string {
  const configured = process.env.MODELS_DIR;
  if (configured) return configured;
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

async function guardedFetch(url: string, init?: RequestInit): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const parsed = new URL(current);
    assertPublicHost(parsed.hostname);
    const response = await fetch(current, { ...init, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    if (hop === MAX_REDIRECTS) throw new Error("stopped after 10 redirects");
    const next = new URL(location, current);
    if (next.protocol !== "https:") throw new Error("redirect must use https");
    current = next.toString();
  }
  throw new Error("stopped after 10 redirects");
}

export async function createContext(config: ProxyConfig): Promise<ProxyContext> {
  const models = ModelRegistry.load(config.modelsDir ?? resolveModelsDirForService());
  const redis = await openRedis(config.redisUrl);
  const auth = new AuthService(models, redis);

  const egress = new UnroxyEgress({ url: config.unroxyUrl, preferred: config.psiphonRegion });
  const directFetch = (url: string, init?: RequestInit): Promise<Response> => {
    return guardedFetch(url, init).catch((error: unknown) =>
      Promise.reject(error instanceof Error ? error : new Error(String(error)))
    );
  };
  const providers = new ProviderRegistry({
    models,
    fallback: new RedisFallbackRouter(redis),
    redis,
    directFetch,
  });
  const egressFetch: EgressFetch = (url, init, region) =>
    egress.fetch(url, init as never, region ? { region } : undefined) as unknown as Promise<Response>;
  providers.setEgress(
    egressFetch,
    true,
    () => undefined
  );

  const service = new ProxyService({
    database: db,
    redis,
    models,
    auth,
    providers,
    betterAuthSecret: config.betterAuthSecret,
    requestTimeoutMs: config.requestTimeoutMs,
  });

  return { config, models, redis, auth, providers, service, egress };
}

export async function disposeContext(context: ProxyContext): Promise<void> {
  await context.egress.close();
  await closeRedis(context.redis);
}
