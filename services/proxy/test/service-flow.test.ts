import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { ProxyService } from "../src/core/service.js";
import { chatCompletionsConfig } from "../src/core/endpoints.js";
import type { AuthResult, AuthService, ModelValidationResult } from "@opendum/auth";
import type { Provider, ProviderRegistry } from "@opendum/providers";
import type { Registry } from "@opendum/models/runtime";
import type { OpendumRedis } from "@opendum/redis";

const db = vi.hoisted(() => {
  const asyncNoop = () => vi.fn(async () => undefined);
  return {
    bumpAccountRequestCount: asyncNoop(),
    deactivateAPIKey: asyncNoop(),
    disableFailedAccount: vi.fn(async () => 0),
    getAccountCredentialsByID: vi.fn(async () => null),
    getAccountHealthState: vi.fn(async () => null),
    getAccountOwnerUserID: vi.fn(async () => null),
    getForcedAccount: vi.fn(async () => null),
    getModelHealth: vi.fn(async () => null),
    insertModelHealth: asyncNoop(),
    insertUsageLog: asyncNoop(),
    listDisabledAccountIDs: vi.fn(async () => []),
    listEligibleAccounts: vi.fn(async () => []),
    listExpiringRefreshableAccounts: vi.fn(async () => []),
    listModelHealthByAccount: vi.fn(async () => []),
    listModelHealthByAccounts: vi.fn(async () => []),
    listSharedEligibleAccounts: vi.fn(async () => []),
    markAccountRecoveredByRotation: asyncNoop(),
    markAccountSuccess: asyncNoop(),
    markUsageLimitedHealth: asyncNoop(),
    recordAccountError: asyncNoop(),
    recordRequestError: asyncNoop(),
    setAccountActive: asyncNoop(),
    setAccountCooldown: asyncNoop(),
    setAccountHealthFailed: asyncNoop(),
    setAccountUsageLimited: asyncNoop(),
    updateModelHealthCounters: asyncNoop(),
    updateModelHealthFailure: asyncNoop(),
    updateModelHealthFailureWithStatus: asyncNoop(),
    updateModelHealthStatus: asyncNoop(),
    updateModelHealthSuccess: asyncNoop(),
    updateModelHealthSuccessWithStatus: asyncNoop(),
    updateRefreshedCredentials: asyncNoop(),
    creditPointBalance: asyncNoop(),
    debitPointBalance: vi.fn(async () => 10),
    debitPointBalanceAllowNegative: vi.fn(async () => 10),
    insertPointBalanceOnConflictDoNothing: vi.fn(async () => 0),
    insertPointTransaction: asyncNoop(),
    insertPointTransactionOnConflictDoNothing: vi.fn(async () => 0),
    updatePointTransactionBalance: asyncNoop(),
    getCustomProvider: vi.fn(async () => null),
    listCustomProviderModels: vi.fn(async () => []),
    listCustomProviders: vi.fn(async () => []),
  };
});

vi.mock("@opendum/database/queries", () => db);

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function validModel(): ModelValidationResult {
  return { valid: true, provider: null, model: "gpt-4o", alias: "", vision: null, error: "", param: "", code: "" };
}

function validAuth(): AuthResult {
  return {
    valid: true, userId: "user-1", apiKeyId: "key-1", modelAccessMode: "all", modelAccessList: [],
    accountAccessMode: "all", accountAccessList: [], roamingEnabled: false, rateLimitRules: [], error: "",
  };
}

describe("ProxyService full flow", () => {
  it("streams the provider response and logs usage", async () => {
    const provider: Provider = {
      name: "opencode",
      makeRequest: async () => sseResponse(['data: {"choices":[{"delta":{"content":"hello"}}]}\n\n', "data: [DONE]\n\n"]),
    };
    const providers = {
      names: () => ["opencode"],
      has: (name: string) => name === "opencode",
      get: (name: string) => (name === "opencode" ? provider : undefined),
      isAuthless: (name: string) => name === "opencode",
      refreshableProviderNames: () => [],
      transport: { direct: () => Promise.reject(new Error("no fetch")) },
    } as unknown as ProviderRegistry;
    const models = {
      providersForModel: () => ["opencode"],
      resolveAlias: (model: string) => model,
      lookupKeys: (model: string) => [model],
      isVisionModel: () => true,
      isSupportedByProvider: () => true,
      providerAccessRule: () => null,
      modelCost: () => null,
      modelsForProvider: () => [],
    } as unknown as Registry;
    const auth = {
      validateAPIKey: async () => validAuth(),
      validateModelForUser: async () => validModel(),
      bumpAnalyticsCacheVersionThrottled: async () => undefined,
    } as unknown as AuthService;
    const redis = { get: async () => null, set: async () => "OK", del: async () => 1, zAdd: async () => 1, zRemRangeByRank: async () => 0, expire: async () => true } as unknown as OpendumRedis;

    db.insertUsageLog.mockClear();
    const service = new ProxyService({
      database: {} as never,
      redis,
      models,
      auth,
      providers,
      betterAuthSecret: "secret",
      requestTimeoutMs: 0,
    });

    const response = await service.handle(
      chatCompletionsConfig(),
      { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true },
      "Bearer ok",
      ""
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const text = await response.text();
    assert.match(text, /hello/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(db.insertUsageLog.mock.calls.length >= 1);
  });
});
