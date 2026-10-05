import assert from "node:assert/strict";
import { beforeEach, describe, it, vi } from "vitest";
import type { ProxyConfig } from "../src/config.js";

const mocks = vi.hoisted(() => ({
  openRedis: vi.fn(),
  closeRedis: vi.fn(),
  authService: vi.fn(),
  resolveModelsDir: vi.fn(),
  registryLoad: vi.fn(),
  unroxy: vi.fn(),
  assertPublicHost: vi.fn(),
  createGuardedFetch: vi.fn(),
  providerRegistry: vi.fn(),
  fallbackRouter: vi.fn(),
  discoverProviderExtensions: vi.fn(),
  registerQuotaProviders: vi.fn(),
  discoverQuotaProviders: vi.fn(),
  proxyService: vi.fn(),
  db: { __db: true },
}));

vi.mock("@opendum/redis", () => ({ openRedis: mocks.openRedis, closeRedis: mocks.closeRedis }));
vi.mock("@opendum/auth", () => ({ AuthService: mocks.authService }));
vi.mock("@opendum/models", () => ({ resolveModelsDir: mocks.resolveModelsDir }));
vi.mock("@opendum/models/runtime", () => ({ Registry: { load: mocks.registryLoad } }));
vi.mock("@opendum/egress", () => ({
  UnroxyEgress: mocks.unroxy,
  assertPublicHost: mocks.assertPublicHost,
  createGuardedFetch: mocks.createGuardedFetch,
}));
vi.mock("@opendum/providers", () => ({ ProviderRegistry: mocks.providerRegistry, RedisFallbackRouter: mocks.fallbackRouter }));
vi.mock("@opendum/providers/extension", () => ({ discoverProviderExtensions: mocks.discoverProviderExtensions }));
vi.mock("@opendum/quota", () => ({ registerQuotaProviders: mocks.registerQuotaProviders }));
vi.mock("@opendum/quota/extension", () => ({ discoverQuotaProviders: mocks.discoverQuotaProviders }));
vi.mock("@opendum/database", () => ({ db: mocks.db }));
vi.mock("../src/core/service.js", () => ({ ProxyService: mocks.proxyService }));

import { createContext, disposeContext } from "../src/context.js";

function config(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    host: "127.0.0.1",
    port: 4001,
    databaseUrl: "postgres://db",
    redisUrl: "redis://cache",
    betterAuthSecret: "secret",
    requestTimeoutMs: 1000,
    tokenRefreshIntervalMs: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.openRedis.mockResolvedValue({ __redis: true });
  mocks.closeRedis.mockResolvedValue(undefined);
  mocks.authService.mockImplementation(function () {
    return { __auth: true };
  });
  mocks.resolveModelsDir.mockReturnValue("/models");
  mocks.registryLoad.mockReturnValue({ __models: true });
  mocks.unroxy.mockImplementation(function () {
    return { fetch: vi.fn(), close: vi.fn(async () => undefined) };
  });
  mocks.createGuardedFetch.mockImplementation(function () {
    return { fetch: vi.fn(async () => new Response("ok")), close: vi.fn(async () => undefined) };
  });
  const setEgress = vi.fn();
  mocks.providerRegistry.mockImplementation(function () {
    return { setEgress, __setEgress: setEgress };
  });
  mocks.fallbackRouter.mockImplementation(function () {
    return { __fallback: true };
  });
  mocks.discoverProviderExtensions.mockResolvedValue([{ name: "ext" }]);
  mocks.discoverQuotaProviders.mockResolvedValue([{ name: "quota" }]);
  mocks.proxyService.mockImplementation(function () {
    return { startTokenRefresher: vi.fn() };
  });
});

describe("createContext", () => {
  it("wires the proxy dependencies", async () => {
    const context = await createContext(config());
    assert.equal(mocks.openRedis.mock.calls[0]![0], "redis://cache");
    assert.equal(mocks.registryLoad.mock.calls.length, 1);
    assert.deepEqual(context.models, { __models: true });
    assert.deepEqual(context.redis, { __redis: true });
    assert.deepEqual(context.auth, { __auth: true });
    assert.equal(mocks.providerRegistry.mock.calls.length, 1);
    assert.equal((context.providers as unknown as { __setEgress: ReturnType<typeof vi.fn> }).__setEgress.mock.calls.length, 1);
    assert.equal(mocks.registerQuotaProviders.mock.calls[0]![0] instanceof Array, true);
    assert.equal(mocks.proxyService.mock.calls.length, 1);
    assert.equal(typeof context.guardedFetch, "function");
    assert.equal(typeof context.closeDirect, "function");
  });

  it("passes optional timeouts and defaults", async () => {
    await createContext(config({ requestTimeoutMs: 0 }));
    const options = mocks.createGuardedFetch.mock.calls[0]![0] as { headersTimeout?: number };
    assert.equal(options.headersTimeout, undefined);

    await createContext(config());
    const withTimeout = mocks.createGuardedFetch.mock.calls.at(-1)![0] as { headersTimeout?: number };
    assert.equal(withTimeout.headersTimeout, 1000);
  });
});

describe("disposeContext", () => {
  it("closes egress, direct fetch and redis", async () => {
    const context = await createContext(config());
    const guard = mocks.createGuardedFetch.mock.results.at(-1)!.value as { close: ReturnType<typeof vi.fn> };
    const egress = mocks.unroxy.mock.results.at(-1)!.value as { close: ReturnType<typeof vi.fn> };
    await disposeContext(context);
    assert.equal(egress.close.mock.calls.length, 1);
    assert.equal(guard.close.mock.calls.length, 1);
    assert.equal(mocks.closeRedis.mock.calls.length, 1);
  });
});

async function contextWithFetch(fetchFn: (url: string, init?: RequestInit) => Promise<Response>) {
  mocks.createGuardedFetch.mockImplementation(function () {
    return { fetch: fetchFn, close: vi.fn(async () => undefined) };
  });
  return createContext(config());
}

describe("guardedFetch redirects", () => {
  it("returns non-redirect responses", async () => {
    const context = await contextWithFetch(async () => new Response("ok", { status: 200 }));
    const response = await context.guardedFetch("https://8.8.8.8/a");
    assert.equal(response.status, 200);
    assert.equal(mocks.assertPublicHost.mock.calls.length, 1);
  });

  it("follows https redirects and rewrites methods", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const context = await contextWithFetch(async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/a")) return new Response(null, { status: 302, headers: { location: "/b" } });
      return new Response("ok", { status: 200 });
    });
    const response = await context.guardedFetch("https://8.8.8.8/a", { method: "POST" });
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.init!.method, "GET");
  });

  it("returns redirects without a location", async () => {
    const context = await contextWithFetch(async () => new Response(null, { status: 302 }));
    assert.equal((await context.guardedFetch("https://8.8.8.8/a")).status, 302);
  });

  it("cancels redirect bodies before following", async () => {
    const context = await contextWithFetch(async (url) => {
      if (url.endsWith("/a")) return new Response("body", { status: 302, headers: { location: "/b" } });
      return new Response("ok", { status: 200 });
    });
    assert.equal((await context.guardedFetch("https://8.8.8.8/a")).status, 200);
  });

  it("rejects non-https redirects", async () => {
    const context = await contextWithFetch(async () => new Response(null, { status: 302, headers: { location: "http://x/b" } }));
    await assert.rejects(context.guardedFetch("https://8.8.8.8/a"), /https/);
  });

  it("stops after too many redirects", async () => {
    const context = await contextWithFetch(async () => new Response(null, { status: 302, headers: { location: "/loop" } }));
    await assert.rejects(context.guardedFetch("https://8.8.8.8/loop"), /10 redirects/);
  });

  it("normalizes direct fetch errors", async () => {
    await contextWithFetch(async () => {
      throw "boom";
    });
    const options = mocks.providerRegistry.mock.calls.at(-1)![0] as { directFetch: (url: string) => Promise<unknown> };
    await assert.rejects(options.directFetch("https://8.8.8.8/a"), (error: unknown) => error instanceof Error);
  });
});
