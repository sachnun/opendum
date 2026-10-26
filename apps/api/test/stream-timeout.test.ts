import { describe, expect, it } from "bun:test";
import type { AuthResult, AuthService, ModelValidationResult } from "@opendum/auth";
import { Effect } from "effect";
import type { Provider, ProviderFailure, ProviderRegistry } from "@opendum/providers";
import type { Registry } from "@opendum/models/runtime";
import type { OpendumRedis } from "@opendum/core/redis";
import { ProxyService } from "@opendum/api/core/service";
import { Chat } from "@opendum/api/core/endpoints";
import { fakes } from "@opendum/api/test/fakes";

function validAuth(): AuthResult {
  return {
    valid: true,
    userId: "user-1",
    apiKeyId: "key-1",
    modelAccessMode: "all",
    modelAccessList: [],
    accountAccessMode: "all",
    accountAccessList: [],
    roamingEnabled: false,
    rateLimitRules: [],
    error: "",
  };
}

function validModel(): ModelValidationResult {
  return {
    valid: true,
    provider: "workbuddy",
    model: "deepseek-v4.1-flash",
    alias: "",
    vision: null,
    error: "",
    param: "",
    code: "",
  };
}

function accountRow(id: string) {
  return {
    id,
    userId: "user-1",
    provider: "workbuddy",
    accountId: `uid-${id}`,
    status: "active",
    tier: null,
    disabledUntil: null,
    lastUsedAt: null,
    createdAt: new Date(),
  };
}

function fakeRedis(): OpendumRedis {
  return {
    get: async () => null,
    set: async () => "OK",
    del: async () => 1,
    zAdd: async () => 1,
    zRemRangeByRank: async () => 0,
    expire: async () => true,
    keys: async () => [],
  } as unknown as OpendumRedis;
}

function harness(options: {
  streamTimeoutMs: number;
  request: (accountId: string) => Effect.Effect<Response, ProviderFailure>;
}) {
  const seen: string[] = [];
  const provider: Provider = {
    name: "workbuddy",
    makeRequest: (request) => {
      seen.push(request.account.id);
      return options.request(request.account.id);
    },
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
    validateFor: () => Effect.succeed(validModel()),
    bumpVersion: () => Effect.void,
  } as unknown as AuthService;

  const repositories = fakes();
  repositories.accounts.listEligibleAccounts.mockImplementation((params) =>
    Effect.succeed(
      [accountRow("acc-1"), accountRow("acc-2")].filter((row) => !params.excludeIds.includes(row.id))
    )
  );

  const service = new ProxyService({
    database: {} as never,
    repositories,
    redis: fakeRedis(),
    models,
    auth,
    providers,
    betterAuthSecret: "secret",
    requestTimeoutMs: 0,
    streamTimeoutMs: options.streamTimeoutMs,
  });

  return { seen, repositories, service };
}

function call(service: InstanceType<typeof ProxyService>): Promise<Response> {
  return service.handle(
    new Chat(),
    { model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }], stream: true },
    "Bearer ok",
    "sess-1"
  );
}

describe("stream header timeout", () => {
  it("rotates to the next account when upstream headers never arrive", async () => {
    const { seen, service } = harness({
      streamTimeoutMs: 40,
      request: (accountId) =>
        accountId === "acc-1"
          ? Effect.never
          : Effect.succeed(
              new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
                status: 200,
                headers: { "content-type": "text/event-stream" },
              })
            ),
    });
    const response = await call(service);
    expect(response.status).toBe(200);
    expect(seen).toEqual(["acc-1", "acc-2"]);
    await response.text();
  });

  it("keeps a slow body streaming after headers arrive", async () => {
    const encoder = new TextEncoder();
    const { service } = harness({
      streamTimeoutMs: 20,
      request: () =>
        Effect.succeed(
          new Response(
            new ReadableStream<Uint8Array>({
              async start(controller) {
                controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
                await Bun.sleep(80);
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } }
          )
        ),
    });
    const response = await call(service);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toMatch(/\[DONE\]/);
  });

  it("returns an error instead of hanging when every account times out", async () => {
    const { seen, service } = harness({
      streamTimeoutMs: 30,
      request: () => Effect.never,
    });
    const response = await call(service);
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(seen).toEqual(["acc-1", "acc-2"]);
    await response.text();
  });
});
