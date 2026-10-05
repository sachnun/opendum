import assert from "node:assert/strict";
import { beforeEach, describe, it, vi } from "vitest";
import type { ProviderAccount } from "@opendum/providers";
import type { OpendumRedis } from "@opendum/redis";

const mocks = vi.hoisted(() => ({
  db: {
    disableFailedAccount: vi.fn(),
    getAccountCredentialsByID: vi.fn(),
    getAccountOwnerUserID: vi.fn(),
    getCustomProvider: vi.fn(),
    listCustomProviderModels: vi.fn(),
    listExpiringRefreshableAccounts: vi.fn(),
    recordAccountError: vi.fn(),
    updateRefreshedCredentials: vi.fn(),
  },
  crypto: { decrypt: vi.fn(), encrypt: vi.fn() },
  history: { upsertErrorHistory: vi.fn() },
}));

vi.mock("@opendum/database/queries", () => mocks.db);
vi.mock("@opendum/crypto", () => mocks.crypto);
vi.mock("../src/core/health/error-history.ts", () => mocks.history);

import { createTransport, type Provider } from "@opendum/providers";
import {
  customProviderForAccount,
  makeProviderRequest,
  quotaCredentials,
  startTokenRefresher,
} from "../src/core/service-credentials.ts";
import type { ProxyDeps } from "../src/core/service-deps.ts";

function redis(overrides: Record<string, unknown> = {}): OpendumRedis {
  return {
    set: vi.fn(async () => "OK"),
    del: vi.fn(async () => 1),
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    get: vi.fn(async () => null),
    ...overrides,
  } as unknown as OpendumRedis;
}

function deps(overrides: Record<string, unknown> = {}): ProxyDeps {
  return {
    secret: "secret",
    requestTimeoutMs: 0,
    database: {},
    redis: redis(),
    providers: {
      get: () => undefined,
      transport: createTransport(async () => new Response("{}")),
      refreshableProviderNames: () => [],
    },
    ...overrides,
  } as unknown as ProxyDeps;
}

function account(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return { id: "a1", userId: "u1", provider: "kiro", isActive: true, accessToken: "enc:tok", refreshToken: "enc:rt", ...overrides };
}

function providerImpl(overrides: Partial<Provider> & Record<string, unknown> = {}): Provider {
  return { name: "kiro", makeRequest: vi.fn(async () => new Response("ok", { status: 200 })), ...overrides } as unknown as Provider;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.crypto.encrypt.mockImplementation((_secret: string, value: string) => `enc:${value}`);
  mocks.crypto.decrypt.mockImplementation((_secret: string, value: string) => {
    if (value.startsWith("enc:")) return value.slice(4);
    throw new Error("cannot decrypt");
  });
  mocks.history.upsertErrorHistory.mockResolvedValue(undefined);
  mocks.db.disableFailedAccount.mockResolvedValue(1);
  mocks.db.getAccountCredentialsByID.mockResolvedValue(null);
  mocks.db.getAccountOwnerUserID.mockResolvedValue(null);
  mocks.db.getCustomProvider.mockResolvedValue(null);
  mocks.db.listCustomProviderModels.mockResolvedValue([]);
  mocks.db.listExpiringRefreshableAccounts.mockResolvedValue([]);
  mocks.db.recordAccountError.mockResolvedValue(undefined);
  mocks.db.updateRefreshedCredentials.mockResolvedValue(undefined);
});

describe("makeProviderRequest", () => {
  it("returns 501 for unknown providers", async () => {
    const response = await makeProviderRequest(deps(), account(), {}, false, () => undefined);
    assert.equal(response.status, 501);
  });

  it("skips credentials for synthetic accounts", async () => {
    const impl = providerImpl();
    const d = deps({ providers: { get: () => impl, transport: createTransport(async () => new Response("{}")) } });
    const response = await makeProviderRequest(d, account({ id: "authless:kiro" }), {}, false, () => undefined);
    assert.equal(response.status, 200);
    assert.equal((impl.makeRequest as ReturnType<typeof vi.fn>).mock.calls[0]![0].credentials, "");
  });

  it("decrypts credentials for normal accounts", async () => {
    const impl = providerImpl();
    const d = deps({ providers: { get: () => impl, transport: createTransport(async () => new Response("{}")) } });
    await makeProviderRequest(d, account(), { model: "m" }, true, () => undefined);
    assert.equal((impl.makeRequest as ReturnType<typeof vi.fn>).mock.calls[0]![0].credentials, "tok");
    assert.equal((impl.makeRequest as ReturnType<typeof vi.fn>).mock.calls[0]![0].stream, true);
  });

  it("refreshes expired credentials", async () => {
    const impl = providerImpl({
      refreshBuffer: () => 0,
      refreshCredentials: vi.fn(async () => ({ accessToken: "new-token", refreshToken: "rt2", expiresAt: new Date(Date.now() + 3600000) })),
    });
    const row = { id: "a1", userId: "u1", provider: "kiro", accessToken: "enc:old", refreshToken: "enc:rt", expiresAt: new Date(Date.now() - 1000), accountId: null, projectId: null, tier: null, email: null, isActive: true };
    mocks.db.getAccountCredentialsByID.mockResolvedValue(row);
    const d = deps({ providers: { get: () => impl, transport: createTransport(async () => new Response("{}")) } });
    await makeProviderRequest(d, account({ expiresAt: new Date(Date.now() - 1000) }), {}, true, () => undefined);
    assert.equal((impl.makeRequest as ReturnType<typeof vi.fn>).mock.calls[0]![0].credentials, "new-token");
    assert.equal(mocks.db.updateRefreshedCredentials.mock.calls.length, 1);
  });

  it("throws when refresh fails on an expired account", async () => {
    const impl = providerImpl({
      refreshBuffer: () => 0,
      refreshCredentials: vi.fn(async () => {
        throw new Error("refresh failed 401");
      }),
    });
    const row = { id: "a1", userId: "u1", provider: "kiro", accessToken: "enc:old", refreshToken: "enc:rt", expiresAt: new Date(Date.now() - 1000), accountId: null, projectId: null, tier: null, email: null, isActive: true };
    mocks.db.getAccountCredentialsByID.mockResolvedValue(row);
    const d = deps({ redis: redis({ incr: vi.fn(async () => 5) }), providers: { get: () => impl, transport: createTransport(async () => new Response("{}")) } });
    await assert.rejects(makeProviderRequest(d, account({ expiresAt: new Date(Date.now() - 1000) }), {}, true, () => undefined), /refresh failed/);
    assert.equal(mocks.db.recordAccountError.mock.calls.length, 1);
    assert.equal(mocks.db.disableFailedAccount.mock.calls.length, 1);
  });

  it("returns upstream error responses", async () => {
    const impl = providerImpl({ makeRequest: vi.fn(async () => new Response("bad", { status: 502 })) });
    const d = deps({ providers: { get: () => impl, transport: createTransport(async () => new Response("{}")) } });
    const response = await makeProviderRequest(d, account(), {}, false, () => undefined);
    assert.equal(response.status, 502);
  });
});

describe("customProviderForAccount", () => {
  it("returns null without a custom provider", async () => {
    assert.equal(await customProviderForAccount(deps(), "u1", "custom"), null);
  });

  it("compiles custom providers", async () => {
    mocks.db.getCustomProvider.mockResolvedValue({ id: "cp1", slug: "custom", baseUrl: "https://api", extraHeaders: null });
    mocks.db.listCustomProviderModels.mockResolvedValue([{ modelId: "m", upstream: null, authless: false, customFlags: null }]);
    const provider = await customProviderForAccount(deps(), "u1", "custom");
    assert.equal(provider?.name, "custom");
  });
});

describe("quotaCredentials", () => {
  it("loads credentials without a provider implementation", async () => {
    mocks.db.getAccountCredentialsByID.mockResolvedValue({ id: "a1", userId: "u1", provider: "kiro", accessToken: "enc:tok", refreshToken: "enc:rt", expiresAt: null, accountId: null, projectId: null, tier: null, email: null, isActive: true });
    assert.equal(await quotaCredentials(deps(), account({ accessToken: undefined, refreshToken: undefined })), "tok");
  });

  it("resolves credentials with a provider implementation", async () => {
    const impl = providerImpl();
    const d = deps({ providers: { get: () => impl, transport: createTransport(async () => new Response("{}")) } });
    assert.equal(await quotaCredentials(d, account()), "tok");
  });
});

describe("startTokenRefresher", () => {
  it("does nothing for non-positive intervals", async () => {
    await startTokenRefresher(deps(), new AbortController().signal, 0);
  });

  it("runs a refresh cycle and stops on abort", async () => {
    const impl = providerImpl({
      refreshBuffer: () => 0,
      refreshCredentials: vi.fn(async () => ({ accessToken: "new", refreshToken: "rt2", expiresAt: new Date(Date.now() + 1000) })),
    });
    mocks.db.listExpiringRefreshableAccounts.mockResolvedValue([
      { id: "a1", userId: "u1", provider: "kiro", accessToken: "enc:old", refreshToken: "enc:rt", expiresAt: new Date(Date.now() - 1000), accountId: null, projectId: null, tier: null, email: null, isActive: true },
    ]);
    mocks.db.getAccountCredentialsByID.mockResolvedValue({ id: "a1", userId: "u1", provider: "kiro", accessToken: "enc:old", refreshToken: "enc:rt", expiresAt: new Date(Date.now() - 1000), accountId: null, projectId: null, tier: null, email: null, isActive: true });
    const d = deps({
      providers: {
        get: () => impl,
        transport: createTransport(async () => new Response("{}")),
        refreshableProviderNames: () => ["kiro"],
      },
    });
    const controller = new AbortController();
    await startTokenRefresher(d, controller.signal, 100000);
    controller.abort();
    assert.equal(mocks.db.updateRefreshedCredentials.mock.calls.length >= 1, true);
  });

  it("survives refresh query failures", async () => {
    const impl = providerImpl();
    mocks.db.listExpiringRefreshableAccounts.mockRejectedValue(new Error("db down"));
    const d = deps({
      providers: { get: () => impl, transport: createTransport(async () => new Response("{}")), refreshableProviderNames: () => ["kiro"] },
    });
    const controller = new AbortController();
    await startTokenRefresher(d, controller.signal, 100000);
    controller.abort();
  });

  it("returns early without refreshable names", async () => {
    await startTokenRefresher(deps({ providers: { get: () => undefined, transport: createTransport(async () => new Response("{}")), refreshableProviderNames: () => [] } }), new AbortController().signal, 100000);
  });

  it("skips missing providers and logs cycle errors", async () => {
    const missing = deps({ providers: { get: () => undefined, transport: createTransport(async () => new Response("{}")), refreshableProviderNames: () => ["kiro"] } });
    await startTokenRefresher(missing, new AbortController().signal, 100000);

    const throwing = deps({
      providers: {
        get: () => providerImpl(),
        transport: createTransport(async () => new Response("{}")),
        refreshableProviderNames: () => {
          throw new Error("boom");
        },
      },
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await startTokenRefresher(throwing, new AbortController().signal, 100000);
    assert.equal(spy.mock.calls.length >= 1, true);
    spy.mockRestore();
  });
});

