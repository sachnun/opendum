import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { ModelRegistry } from "@opendum/ai";
import { config } from "./config.js";
import { getRedisClient } from "./redis.js";
import { AuthService } from "./auth/service.js";
import { writeOpenAIError } from "./errors.js";
import { validateInternalSignature } from "./auth/internal.js";

const app = new Hono();

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["*"],
    exposeHeaders: ["*"],
    credentials: true,
  })
);

app.get("/health", (c) => c.json({ status: "ok" }));

app.get("/", (c) => c.redirect("/v1", 308));

app.get("/v1", (c) =>
  writeOpenAIError(c, 404, {
    message: "Unknown API endpoint.",
    type: "invalid_request_error",
  })
);

let registry: ModelRegistry;
let authService: AuthService;

async function bootstrap() {
  registry = ModelRegistry.fromDirectory(config.modelsDir);
  const redis = await getRedisClient();
  authService = new AuthService(redis, registry);

  app.get("/v1/models", async (c) => {
    const authHeader =
      c.req.header("authorization") || c.req.header("x-api-key");
    const allModels = registry.formatModelsForOpenAI();

    if (!authHeader) {
      return c.json({ object: "list", data: allModels });
    }

    const authResult = await authService.validateAPIKey(authHeader);
    if (!authResult.valid) {
      return writeOpenAIError(c, 401, {
        message: authResult.error || "Unauthorized",
        type: "authentication_error",
      });
    }

    const userId = authResult.userId!;
    const disabledSet = await authService.disabledModelSetForUser(userId);
    const availability =
      await authService.getAccountModelAvailabilityWithSharing(
        userId,
        Boolean(authResult.roamingEnabled)
      );

    const apiKeyModelSet = new Set(
      (authResult.modelAccessList ?? []).map((m) => registry.resolveAlias(m))
    );

    const enabled = allModels.filter((item) => {
      const canonical = registry.resolveAlias(item.id);
      if (disabledSet.has(canonical)) return false;

      const usableOwned = authService.isModelUsableByAccounts(
        canonical,
        availability
      );
      const usableShared =
        authResult.roamingEnabled &&
        authService.isModelUsableBySharedAccounts(canonical, availability);

      if (!usableOwned && !usableShared) return false;

      if (authResult.modelAccessMode === "whitelist") {
        if (!apiKeyModelSet.has(canonical)) return false;
      }
      if (authResult.modelAccessMode === "blacklist") {
        if (apiKeyModelSet.has(canonical)) return false;
      }

      return true;
    });

    return c.json({ object: "list", data: enabled });
  });

  app.post("/internal/refresh", async (c) => {
    const rawBody = await c.req.text();
    if (!validateInternalSignature(c, "/internal/refresh", rawBody)) {
      c.header("X-Opendum-Internal-Relay-Error", "1");
      return c.json({ error: "Invalid internal refresh signature" }, 401);
    }

    let payload: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
    };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      c.header("X-Opendum-Internal-Relay-Error", "1");
      return c.json({ error: "Invalid internal refresh payload" }, 400);
    }

    if (!payload.url || !payload.url.startsWith("https://")) {
      c.header("X-Opendum-Internal-Relay-Error", "1");
      return c.json({ error: "url must be an https provider URL" }, 400);
    }

    try {
      const resp = await fetch(payload.url, {
        method: payload.method || "GET",
        headers: payload.headers,
        body: payload.body
          ? typeof payload.body === "string"
            ? payload.body
            : JSON.stringify(payload.body)
          : undefined,
      });

      const respHeaders = new Headers();
      resp.headers.forEach((val, key) => {
        const lower = key.toLowerCase();
        if (
          !lower.startsWith("proxy-") &&
          ![
            "connection",
            "keep-alive",
            "transfer-encoding",
            "set-cookie",
          ].includes(lower)
        ) {
          respHeaders.set(key, val);
        }
      });

      const respBody = await resp.arrayBuffer();
      return new Response(respBody, {
        status: resp.status,
        headers: respHeaders,
      });
    } catch (err: any) {
      c.header("X-Opendum-Internal-Relay-Error", "1");
      return c.json(
        {
          error: `Internal relay upstream request failed: ${err?.message || err}`,
        },
        502
      );
    }
  });

  app.notFound((c) => {
    const path = c.req.path;
    return writeOpenAIError(c, 404, {
      message: path.startsWith("/v1") ? "Unknown API endpoint." : "Not Found",
      type: "invalid_request_error",
    });
  });

  serve(
    {
      fetch: app.fetch,
      port: config.port,
      hostname: config.host,
    },
    (info) => {
      console.log(`Opendum Hono proxy listening on ${info.address}:${info.port}`);
    }
  );
}

bootstrap().catch((err) => {
  console.error("Failed to bootstrap proxy:", err);
  process.exit(1);
});
