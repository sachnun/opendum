import { describe, expect, it } from "bun:test";
import type { AuthResult, AuthService, ModelValidationResult } from "@opendum/auth";
import { Effect } from "effect";
import type { ProviderRegistry } from "@opendum/providers";
import type { Registry } from "@opendum/models/runtime";
import type { OpendumRedis } from "@opendum/core/redis";
import { ProxyService } from "@opendum/api/core/service";
import { Chat } from "@opendum/api/core/endpoints";
import { fakes } from "@opendum/api/test/fakes";

type ProxyServiceInstance = InstanceType<typeof ProxyService>;

function validAuth(overrides: Partial<AuthResult> = {}): AuthResult {
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
    ...overrides,
  };
}

function validModel(): ModelValidationResult {
  return {
    valid: true,
    provider: null,
    model: "gpt-4o",
    alias: "",
    vision: null,
    error: "",
    param: "",
    code: "",
  };
}

function fakeRedis(overrides: Partial<Record<string, unknown>> = {}): OpendumRedis {
  return {
    get: async () => null,
    set: async () => "OK",
    del: async () => 1,
    incr: async () => 1,
    expire: async () => true,
    zAdd: async () => 1,
    zRemRangeByRank: async () => 0,
    ...overrides,
  } as unknown as OpendumRedis;
}

function fakeModels(overrides: Partial<Record<string, unknown>> = {}): Registry {
  return {
    providers: () => [],
    resolveAlias: (model: string) => model,
    lookupKeys: (model: string) => [model],
    isVisionModel: () => true,
    supportsProvider: () => true,
    rule: () => null,
    modelCost: () => null,
    models: () => [],
    ...overrides,
  } as unknown as Registry;
}

function fakeProviders(): ProviderRegistry {
  return {
    names: () => [],
    has: () => false,
    get: () => undefined,
    isAuthless: () => false,
    refreshableProviderNames: () => [],
    transport: { direct: () => Effect.runPromise(Effect.fail(new Error("no fetch"))) },
  } as unknown as ProviderRegistry;
}

function buildService(options: {
  auth: AuthService;
  models?: Registry;
  redis?: OpendumRedis;
  providers?: ProviderRegistry;
}): ProxyServiceInstance {
  return new ProxyService({
    database: {} as never,
    repositories: fakes(),
    redis: options.redis ?? fakeRedis(),
    models: options.models ?? fakeModels(),
    auth: options.auth,
    providers: options.providers ?? fakeProviders(),
    betterAuthSecret: "secret",
    requestTimeoutMs: 0,
  });
}

const cfg = new Chat();
const chatBody = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] };

describe("ProxyService.handle", () => {
  it("rejects an invalid API key with 401", async () => {
    const auth = {
      validateKey: () => Effect.succeed({ ...validAuth(), valid: false, error: "Invalid API key" }),
      validateFor: () => Effect.succeed(validModel()),
      bumpVersion: () => Effect.void,
    } as unknown as AuthService;
    const service = buildService({ auth });
    const response = await service.handle(cfg, chatBody, "Bearer bad", "");
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("authentication_error");
    expect(body.error.message).toBe("Invalid API key");
  });

  it("rejects an invalid model with 400", async () => {
    const auth = {
      validateKey: () => Effect.succeed(validAuth()),
      validateFor: () =>
        Effect.succeed({ ...validModel(), valid: false, model: "nope", error: "Invalid model: nope.", param: "model", code: "invalid_model" }),
      bumpVersion: () => Effect.void,
    } as unknown as AuthService;
    const service = buildService({ auth });
    const response = await service.handle(cfg, { ...chatBody, model: "nope" }, "Bearer ok", "");
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; param: string } };
    expect(body.error.code).toBe("invalid_model");
    expect(body.error.param).toBe("model");
  });

  it("rejects a rate-limited request with 429", async () => {
    const auth = {
      validateKey: () =>
        Effect.succeed(
          validAuth({
            rateLimitRules: [{ target: "gpt-4o", targetType: "model", perMinute: 1, perHour: null, perDay: null }],
          })
        ),
      validateFor: () => Effect.succeed(validModel()),
      bumpVersion: () => Effect.void,
    } as unknown as AuthService;
    const service = buildService({ auth, redis: fakeRedis({ get: async () => "1" }) });
    const response = await service.handle(cfg, chatBody, "Bearer ok", "");
    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: { type: string } };
    expect(body.error.type).toBe("rate_limit_error");
  });

  it("returns 503 configuration_error when no accounts exist", async () => {
    const auth = {
      validateKey: () => Effect.succeed(validAuth()),
      validateFor: () => Effect.succeed(validModel()),
      bumpVersion: () => Effect.void,
    } as unknown as AuthService;
    const service = buildService({ auth });
    const response = await service.handle(cfg, chatBody, "Bearer ok", "");
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("configuration_error");
    expect(body.error.message).toMatch(/No active accounts/);
  });

  it("rejects an invalid playground session with 401", async () => {
    const auth = {
      validateKey: () => Effect.succeed(validAuth()),
      validateFor: () => Effect.succeed(validModel()),
      bumpVersion: () => Effect.void,
    } as unknown as AuthService;
    const service = buildService({ auth });
    const request = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "x-opendum-playground-user-id": "user-1",
        "x-opendum-playground-timestamp": "1",
        "x-opendum-playground-signature": "deadbeef",
      },
    });
    const response = await service.handle(cfg, chatBody, "", "", request);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Invalid playground session");
  });
});
