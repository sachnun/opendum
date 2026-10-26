import { describe, expect, it } from "bun:test";
import type { AuthResult, AuthService, ModelValidationResult } from "@opendum/auth";
import { Effect } from "effect";
import type { Provider, ProviderRegistry } from "@opendum/providers";
import type { Registry } from "@opendum/models/runtime";
import type { OpendumRedis } from "@opendum/core/redis";
import { ProxyService } from "@opendum/api/core/service";
import { Chat } from "@opendum/api/core/endpoints";
import { fakes } from "@opendum/api/test/fakes";

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
      makeRequest: () =>
        Effect.succeed(sseResponse(['data: {"choices":[{"delta":{"content":"hello"}}]}\n\n', "data: [DONE]\n\n"])),
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
      providers: () => ["opencode"],
      resolveAlias: (model: string) => model,
      lookupKeys: (model: string) => [model],
      isVisionModel: () => true,
      supportsProvider: () => true,
      rule: () => null,
      modelCost: () => null,
      models: () => [],
    } as unknown as Registry;
    const auth = {
      validateKey: () => Effect.succeed(validAuth()),
      validateFor: () => Effect.succeed(validModel()),
      bumpVersion: () => Effect.void,
    } as unknown as AuthService;
    const redis = { get: async () => null, set: async () => "OK", del: async () => 1, zAdd: async () => 1, zRemRangeByRank: async () => 0, expire: async () => true } as unknown as OpendumRedis;

    const repositories = fakes();
    const service = new ProxyService({
      database: {} as never,
      repositories,
      redis,
      models,
      auth,
      providers,
      betterAuthSecret: "secret",
      requestTimeoutMs: 0,
    });

    const response = await service.handle(
      new Chat(),
      { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true },
      "Bearer ok",
      ""
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const text = await response.text();
    expect(text).toMatch(/hello/);
    for (let attempt = 0; attempt < 50 && repositories.usage.insertUsageLog.mock.calls.length === 0; attempt += 1) {
      await Bun.sleep(10);
    }
    expect(repositories.usage.insertUsageLog.mock.calls.length >= 1).toBe(true);
  });

  it("cools down a workbuddy account when the provider reports a risk restriction", async () => {
    const provider: Provider = {
      name: "workbuddy",
      makeRequest: () =>
        Effect.succeed(new Response(JSON.stringify({ code: 11140, msg: "request illegal" }), { status: 403 })),
    };
    const providers = {
      names: () => ["workbuddy"],
      has: (name: string) => name === "workbuddy",
      get: (name: string) => (name === "workbuddy" ? provider : undefined),
      isAuthless: () => false,
      refreshableProviderNames: () => [],
      transport: { direct: () => Promise.reject(new Error("no fetch")) },
    } as unknown as ProviderRegistry;
    const models = {
      providers: () => ["workbuddy"],
      resolveAlias: (model: string) => model,
      lookupKeys: (model: string) => [model],
      isVisionModel: () => true,
      supportsProvider: () => true,
      isAuthless: () => false,
      rule: () => null,
      modelCost: () => null,
      models: () => [],
    } as unknown as Registry;
    const auth = {
      validateKey: () => Effect.succeed(validAuth()),
      validateFor: () => Effect.succeed({ ...validModel(), model: "deepseek-v4.1-flash", provider: "workbuddy" }),
      bumpVersion: () => Effect.void,
    } as unknown as AuthService;
    const redis = { get: async () => null, set: async () => "OK", del: async () => 1, zAdd: async () => 1, zRemRangeByRank: async () => 0, expire: async () => true } as unknown as OpendumRedis;

    const repositories = fakes();
    repositories.accounts.listEligibleAccounts.mockImplementation((params) => {
      if (params.excludeIds.includes("acc-1")) return Effect.succeed([]);
      return Effect.succeed([
        {
          id: "acc-1",
          userId: "user-1",
          provider: "workbuddy",
          accountId: "uid-1",
          status: "active",
          tier: null,
          disabledUntil: null,
          lastUsedAt: null,
          createdAt: new Date(),
        } as never,
      ]);
    });
    const service = new ProxyService({
      database: {} as never,
      repositories,
      redis,
      models,
      auth,
      providers,
      betterAuthSecret: "secret",
      requestTimeoutMs: 0,
    });

    const response = await service.handle(
      new Chat(),
      { model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }], stream: true },
      "Bearer ok",
      ""
    );
    expect(response.status).toBe(403);
    expect(repositories.health.markUsageLimited.mock.calls.length).toBe(1);
    const limited = repositories.health.markLimited.mock.calls[0]?.[0];
    expect(limited?.id).toBe("acc-1");
    expect(limited?.status).toBe("failed");
    expect(limited?.disabledUntil.getTime()).toBeGreaterThan(Date.now() + 29 * 60 * 1000);
  });
});
