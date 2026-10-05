import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import type { H3, H3Event } from "h3";
import type { ProxyContext } from "../src/context.ts";

vi.mock("@opendum/database/queries", () => ({}));

import { jsonResponse, notFound, unknownEndpoint } from "../src/routes/errors.ts";
import { registerModelsRoute } from "../src/routes/models.ts";
import { registerInferenceRoutes } from "../src/routes/inference.ts";

type Handler = (event: H3Event) => Promise<Response> | Response;

function capture(): { app: H3; routes: Map<string, Handler> } {
  const routes = new Map<string, Handler>();
  const app = {
    get: (path: string, handler: Handler) => routes.set(`GET ${path}`, handler),
    post: (path: string, handler: Handler) => routes.set(`POST ${path}`, handler),
  } as unknown as H3;
  return { app, routes };
}

function event(options: { headers?: Record<string, string>; body?: unknown; jsonThrows?: boolean } = {}): H3Event {
  const headers = new Headers(options.headers ?? {});
  return {
    req: {
      headers,
      json: async () => {
        if (options.jsonThrows) throw new Error("bad json");
        return options.body;
      },
    },
  } as unknown as H3Event;
}

describe("routes/errors", () => {
  it("builds json responses", async () => {
    const response = jsonResponse({ ok: true }, 201, { "x-extra": "1" });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("x-extra"), "1");
    assert.deepEqual(await response.json(), { ok: true });

    const unknown = unknownEndpoint();
    assert.equal(unknown.status, 404);
    assert.equal(notFound().status, 404);
  });
});

describe("routes/models", () => {
  function context(overrides: Record<string, unknown> = {}): ProxyContext {
    return {
      auth: {
        validateAPIKey: vi.fn(async () => ({
          valid: true,
          userId: "u1",
          apiKeyId: "k1",
          modelAccessMode: "all",
          modelAccessList: [],
          accountAccessMode: "all",
          accountAccessList: [],
          roamingEnabled: false,
          rateLimitRules: [],
          error: "",
        })),
        disabledModelSetForUser: vi.fn(async () => new Set<string>()),
        getAccountModelAvailabilityWithSharing: vi.fn(async () => ({ accountCountByProvider: new Map() })),
        isModelUsableByAccounts: vi.fn(() => true),
        isModelUsableBySharedAccounts: vi.fn(() => false),
        listUserCustomModels: vi.fn(async () => []),
      },
      models: {
        resolveAlias: (model: string) => model,
        formatModelsForOpenAI: () => [{ id: "m1", providers: ["kiro"] }],
      },
      ...overrides,
    } as unknown as ProxyContext;
  }

  function handler(context: ProxyContext): Handler {
    const { app, routes } = capture();
    registerModelsRoute(app, context);
    return routes.get("GET /v1/models")!;
  }

  it("lists all models without auth", async () => {
    const response = await handler(context())(event());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { object: "list", data: [{ id: "m1", providers: ["kiro"] }] });
  });

  it("rejects invalid keys", async () => {
    const ctx = context();
    (ctx.auth.validateAPIKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ valid: false, error: "nope" });
    const response = await handler(ctx)(event({ headers: { authorization: "Bearer x" } }));
    assert.equal(response.status, 401);
  });

  it("filters models for authenticated users", async () => {
    const ctx = context();
    (ctx.auth.isModelUsableByAccounts as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const response = await handler(ctx)(event({ headers: { authorization: "Bearer x" } }));
    const body = (await response.json()) as { data: unknown[] };
    assert.equal(body.data.length, 1);
  });

  it("applies whitelist and blacklist access modes", async () => {
    const whitelist = context();
    (whitelist.auth.validateAPIKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      valid: true,
      userId: "u1",
      modelAccessMode: "whitelist",
      modelAccessList: ["kiro/m1"],
      roamingEnabled: false,
    });
    (whitelist.auth.isModelUsableByAccounts as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const whitelisted = (await (await handler(whitelist)(event({ headers: { authorization: "Bearer x" } }))).json()) as { data: Array<{ id: string }> };
    assert.deepEqual(whitelisted.data.map((item) => item.id), ["kiro/m1"]);

    const blacklist = context();
    (blacklist.auth.validateAPIKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      valid: true,
      userId: "u1",
      modelAccessMode: "blacklist",
      modelAccessList: ["kiro/m1"],
      roamingEnabled: false,
    });
    (blacklist.auth.isModelUsableByAccounts as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const blocked = (await (await handler(blacklist)(event({ headers: { authorization: "Bearer x" } }))).json()) as { data: Array<{ id: string; providers: string[] }> };
    assert.deepEqual(blocked.data, [{ id: "m1", providers: [] }]);
  });

  it("includes custom models with matching availability", async () => {
    const ctx = context();
    (ctx.auth.isModelUsableByAccounts as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (ctx.auth.listUserCustomModels as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ id: "custom/m1", object: "model" }]);
    (ctx.auth.getAccountModelAvailabilityWithSharing as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      accountCountByProvider: new Map([["custom", 1]]),
    });
    const body = (await (await handler(ctx)(event({ headers: { authorization: "Bearer x" } }))).json()) as { data: Array<{ id: string }> };
    assert.equal(body.data.some((item) => item.id === "custom/m1"), true);
  });

  it("filters disabled and unusable models", async () => {
    const disabled = context();
    (disabled.auth.disabledModelSetForUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Set(["m1"]));
    const disabledBody = (await (await handler(disabled)(event({ headers: { authorization: "Bearer x" } }))).json()) as { data: unknown[] };
    assert.deepEqual(disabledBody.data, []);

    const unusable = context();
    (unusable.auth.isModelUsableByAccounts as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const unusableBody = (await (await handler(unusable)(event({ headers: { authorization: "Bearer x" } }))).json()) as { data: unknown[] };
    assert.deepEqual(unusableBody.data, []);
  });

  it("handles whitelist and blacklist canonical entries", async () => {
    const whitelist = context();
    (whitelist.auth.validateAPIKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ valid: true, userId: "u1", modelAccessMode: "whitelist", modelAccessList: ["m1"], roamingEnabled: false });
    (whitelist.auth.isModelUsableByAccounts as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const whitelisted = (await (await handler(whitelist)(event({ headers: { authorization: "Bearer x" } }))).json()) as { data: Array<{ id: string }> };
    assert.deepEqual(whitelisted.data.map((item) => item.id), ["m1"]);

    const blacklist = context();
    (blacklist.auth.validateAPIKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ valid: true, userId: "u1", modelAccessMode: "blacklist", modelAccessList: ["m1"], roamingEnabled: false });
    (blacklist.auth.isModelUsableByAccounts as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const blocked = (await (await handler(blacklist)(event({ headers: { authorization: "Bearer x" } }))).json()) as { data: unknown[] };
    assert.deepEqual(blocked.data, []);
  });

  it("filters custom models by disabled state and access mode", async () => {
    const custom = (disabled: string[], mode: string, list: string[]) => {
      const ctx = context();
      (ctx.auth.isModelUsableByAccounts as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (ctx.auth.validateAPIKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ valid: true, userId: "u1", modelAccessMode: mode, modelAccessList: list, roamingEnabled: false });
      (ctx.auth.disabledModelSetForUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Set(disabled));
      (ctx.auth.listUserCustomModels as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ id: "custom/m1", object: "model" }]);
      (ctx.auth.getAccountModelAvailabilityWithSharing as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ accountCountByProvider: new Map([["custom", 1]]) });
      return ctx;
    };
    const run = async (ctx: ProxyContext) => ((await (await handler(ctx)(event({ headers: { authorization: "Bearer x" } }))).json()) as { data: Array<{ id: string }> }).data;
    const hasCustom = (items: Array<{ id: string }>) => items.some((item) => item.id === "custom/m1");
    assert.equal(hasCustom(await run(custom(["custom/m1"], "all", []))), false);
    assert.equal(hasCustom(await run(custom([], "whitelist", []))), false);
    assert.equal(hasCustom(await run(custom([], "blacklist", ["custom/m1"]))), false);

    const noAvailability = context();
    (noAvailability.auth.isModelUsableByAccounts as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (noAvailability.auth.listUserCustomModels as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ id: "custom/m1", object: "model" }]);
    assert.equal(hasCustom(await run(noAvailability)), false);
  });
});

describe("routes/inference", () => {
  function context(): ProxyContext {
    return { service: { handle: vi.fn(async () => jsonResponse({ ok: true })) } } as unknown as ProxyContext;
  }

  function handlers(ctx: ProxyContext): Map<string, Handler> {
    const { app, routes } = capture();
    registerInferenceRoutes(app, ctx);
    return routes;
  }

  it("forwards valid requests", async () => {
    const ctx = context();
    const handler = handlers(ctx).get("POST /v1/chat/completions")!;
    const response = await handler(event({ body: { model: "m1" } }));
    assert.equal(response.status, 200);
    assert.equal((ctx.service.handle as ReturnType<typeof vi.fn>).mock.calls.length, 1);
  });

  it("rejects invalid bodies", async () => {
    const ctx = context();
    const handler = handlers(ctx).get("POST /v1/messages")!;
    assert.equal((await handler(event({ jsonThrows: true }))).status, 400);
    assert.equal((await handler(event({ body: [1, 2] }))).status, 400);
  });

  it("registers all inference routes", () => {
    const routes = handlers(context());
    assert.equal(routes.has("POST /v1/chat/completions"), true);
    assert.equal(routes.has("POST /v1/messages"), true);
    assert.equal(routes.has("POST /v1/responses"), true);
  });

  it("forwards responses requests", async () => {
    const ctx = context();
    const handler = handlers(ctx).get("POST /v1/responses")!;
    const response = await handler(event({ body: { model: "m1", input: "hi" } }));
    assert.equal(response.status, 200);
    assert.equal((ctx.service.handle as ReturnType<typeof vi.fn>).mock.calls.length, 1);
  });
});
