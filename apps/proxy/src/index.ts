import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import "dotenv/config";

import { loadConfig } from "./config.js";
import { openDb, type ProxyDB } from "./db/index.js";
import { openRedis } from "./redis/index.js";
import { Registry } from "./registry/index.js";
import { AuthService } from "./auth/service.js";
import { AuthModelService } from "./auth/models.js";
import { ProxyService } from "./service.js";
import { openAIErrorBody, validateInternalSignature } from "./errors.js";
import { InternalRelay } from "./internal.js";
import { streamFromAsyncIterable } from "./providers/http.js";

export interface CreateAppOptions {
  db?: ProxyDB | null;
  redis?: ReturnType<typeof openRedis> | null;
  secret?: string;
  modelsDir?: string;
  registry?: Registry;
  config?: ReturnType<typeof loadConfig>;
  tokenRefreshIntervalSeconds?: number;
}

export function createApp(options: CreateAppOptions = {}) {
  const cfg = options.config ?? loadConfig();
  const db = options.db !== undefined ? options.db : openDb(cfg.databaseUrl);
  const redis = options.redis !== undefined ? options.redis : openRedis(cfg.redisUrl);
  const secret = options.secret ?? cfg.betterAuthSecret;
  const registry = options.registry ?? Registry.load(options.modelsDir ?? cfg.modelsDir);

  const authSvc = new AuthService(db, redis, registry);
  const authModels = new AuthModelService(db, redis, registry);
  const svc = new ProxyService(db, redis, authSvc, authModels, registry, secret);

  const internalRelay = new InternalRelay(svc.client, secret, (request, path, body) => validateInternalSignature(secret, request, path, body));

  const app = new Hono();
  app.use(logger());
  app.use("*", cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["*"],
    exposeHeaders: ["*"],
    credentials: true,
  }));

  app.get("/", (c) => c.redirect("/v1", 301));
  app.get("/v1", (c) => {
    const { status, headers, body } = openAIErrorBody(404, { message: "Unknown API endpoint.", type: "invalid_request_error" });
    c.header("content-type", headers["content-type"] ?? "application/json");
    return respond(c, body, status);
  });

  const respond = (c: Context, data: string | ReadableStream<Uint8Array>, status: number) => c.body(data, status as ContentfulStatusCode);

  const routeAdapter = (endpoint: ReturnType<ProxyService["chatCompletionsConfig"]>) => async (c: Context) => {
    const result = await svc.handle(c.req.raw, endpoint);
    for (const [key, value] of Object.entries(result.headers)) {
      c.header(key, value);
    }
    if (typeof result.body === "string") {
      return respond(c, result.body, result.status);
    }
    const stream = streamFromAsyncIterable(streamBody(result.body));
    return respond(c, stream, result.status);
  };

  app.get("/v1/models", async (c) => {
    const authHeader = c.req.header("authorization") ?? c.req.header("x-api-key") ?? "";
    let userID = "";
    let apiKeyModelAccessMode = "all";
    let roamingEnabled = false;
    const apiKeyModelSet = new Set<string>();
    if (authHeader !== "") {
      let result;
      try {
        result = await authSvc.validateAPIKey(authHeader);
      } catch {
        const { status, body } = openAIErrorBody(500, { message: "Internal server error.", type: "api_error" });
      return respond(c, body, status);
      }
      if (!result.valid) {
        const { status, body } = openAIErrorBody(401, { message: result.error, type: "authentication_error" });
        return respond(c, body, status);
      }
      userID = result.userId;
      apiKeyModelAccessMode = result.modelAccessMode;
      roamingEnabled = result.roamingEnabled;
      for (const model of result.modelAccessList) {
        apiKeyModelSet.add(registry.resolveAlias(model));
      }
    }

    const allModels = registry.formatModelsForOpenAI();
    if (userID === "") {
      return c.json({ object: "list", data: allModels });
    }

    let disabledSet: Set<string>;
    let availability;
    try {
      disabledSet = await authModels.disabledModelSetForUser(userID);
      availability = await authModels.getAccountModelAvailabilityWithSharing(userID, roamingEnabled);
    } catch {
      const { status, body } = openAIErrorBody(500, { message: "Internal server error.", type: "api_error" });
      return respond(c, body, status);
    }

    const enabled: Array<Record<string, unknown>> = [];
    for (const item of allModels) {
      const id = typeof item["id"] === "string" ? item["id"] : "";
      const canonical = registry.resolveAlias(id);
      if (disabledSet.has(canonical)) continue;
      if (!authModels.isModelUsableByOwnedAccounts(canonical, availability) && !(roamingEnabled && authModels.isModelUsableBySharedAccounts(canonical, availability))) {
        continue;
      }
      if (apiKeyModelAccessMode === "whitelist") {
        if (!apiKeyModelSet.has(canonical)) continue;
      }
      if (apiKeyModelAccessMode === "blacklist") {
        if (apiKeyModelSet.has(canonical)) continue;
      }
      enabled.push(item);
    }
    return c.json({ object: "list", data: enabled });
  });

  app.post("/v1/chat/completions", routeAdapter(svc.chatCompletionsConfig()));
  app.post("/v1/messages", routeAdapter(svc.messagesAdapter()));
  app.post("/v1/responses", routeAdapter(svc.responsesAdapter()));

  app.post("/internal/refresh", async (c) => {
    const result = await internalRelay.handle(c.req.raw, "/internal/refresh");
    for (const [key, value] of Object.entries(result.headers)) c.header(key, value);
    if (typeof result.body === "string") return respond(c, result.body, result.status);
    return respond(c, streamFromAsyncIterable(streamBody(result.body)), result.status);
  });

  app.post("/internal/quota", async (c) => {
    const rawBody = await c.req.arrayBuffer();
    const bodyBytes = new Uint8Array(rawBody);
    if (bodyBytes.length > 64 << 10) {
      return c.json({ success: false, error: "Invalid quota payload" }, 400);
    }
    if (!validateInternalSignature(secret, c.req.raw, "/internal/quota", bodyBytes)) {
      return c.json({ success: false, error: "Invalid internal quota signature" }, 401);
    }
    let input: { userId?: unknown; provider?: unknown; accountId?: unknown; forceRefresh?: unknown };
    try {
      input = JSON.parse(new TextDecoder().decode(bodyBytes)) as typeof input;
    } catch {
      return c.json({ success: false, error: "Invalid quota payload" }, 400);
    }
    const userId = typeof input.userId === "string" ? input.userId.trim() : "";
    const provider = typeof input.provider === "string" ? input.provider.trim() : "";
    const accountId = typeof input.accountId === "string" ? input.accountId.trim() : "";
    if (userId === "" || provider === "" || accountId === "") {
      return c.json({ success: false, error: "userId, provider, and accountId are required" }, 400);
    }
    try {
      const data = await svc.fetchQuota({ userId, provider, accountId, forceRefresh: input.forceRefresh === true });
      return c.json({ success: true, data });
    } catch (error) {
      const message = (error as Error).message;
      if (message === "Account not found") {
        return c.json({ success: false, error: "Account not found" }, 404);
      }
      return c.json({ success: false, error: message }, 200);
    }
  });

  app.notFound((c) => {
    const path = c.req.path;
    if (path.startsWith("/v1") || path === "/v1") {
      const { status, headers, body } = openAIErrorBody(404, { message: "Unknown API endpoint.", type: "invalid_request_error" });
      c.header("content-type", headers["content-type"] ?? "application/json");
      return respond(c, body, status);
    }
    const { status, body } = openAIErrorBody(404, { message: "Not Found", type: "invalid_request_error" });
    c.header("content-type", "application/json");
    return respond(c, body, status);
  });

  return { app, svc, registry, db, redis, authSvc, authModels };
}

async function* streamBody(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) yield decoder.decode(value, { stream: true });
  }
}

export default createApp;
