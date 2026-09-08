import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { ModelRegistry, ProviderRegistry } from "@opendum/ai";
import { config } from "./config.js";
import { getRedisClient } from "./redis.js";
import { AuthService } from "./auth/service.js";
import { LoadBalancer } from "./proxy/balancer.js";
import { SessionAffinity } from "./proxy/affinity.js";
import { writeOpenAIError } from "./errors.js";
import {
  createHealthRoute,
  createModelsRoute,
  createInternalRoute,
  createChatRoute,
  createMessagesRoute,
  createResponsesRoute,
} from "./routes/index.js";
import { TokenRefresherWorker } from "./workers/refresher.js";

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

async function bootstrap() {
  const registry = ModelRegistry.fromDirectory(config.modelsDir);
  const redis = await getRedisClient();
  const authService = new AuthService(redis, registry);
  const providers = new ProviderRegistry(registry);
  await providers.autoDiscover();

  const loadBalancer = new LoadBalancer(registry);
  const affinity = new SessionAffinity(redis, new Set(providers.getNames()));

  if (config.tokenRefreshIntervalSeconds > 0) {
    const worker = new TokenRefresherWorker(
      providers,
      config.tokenRefreshIntervalSeconds
    );
    worker.start();
  }

  app.route("/", createHealthRoute());
  app.route("/", createModelsRoute(authService, registry));
  app.route("/", createInternalRoute());
  app.route("/", createChatRoute(authService, registry, providers, loadBalancer, affinity));
  app.route("/", createMessagesRoute(authService, registry, providers, loadBalancer));
  app.route("/", createResponsesRoute(authService, registry, providers, loadBalancer));

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
