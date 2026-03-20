import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { chatCompletionsRoute } from "./routes/chat-completions.js";
import { messagesRoute } from "./routes/messages.js";
import { responsesRoute } from "./routes/responses.js";
import { modelsRoute } from "./routes/models.js";

const PORT = parseInt(process.env.PORT ?? "4000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
  },
  bodyLimit: 10 * 1024 * 1024, // 10 MB
});

// CORS
await app.register(cors, {
  origin: process.env.CORS_ORIGIN ?? true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Api-Key"],
  exposedHeaders: ["X-Provider-Account-Id"],
});

// Health check
app.get("/health", async () => {
  return { status: "ok", timestamp: new Date().toISOString() };
});

// Root redirect
app.get("/", async (_request, reply) => {
  return reply.redirect(process.env.DASHBOARD_URL ?? "https://opendum.app");
});

// V1 root redirect
app.get("/v1", async (_request, reply) => {
  return reply.redirect(process.env.DASHBOARD_URL ?? "https://opendum.app");
});

// Proxy routes
app.post("/v1/chat/completions", chatCompletionsRoute);
app.post("/v1/messages", messagesRoute);
app.post("/v1/responses", responsesRoute);
app.get("/v1/models", modelsRoute);

// 404 for unknown v1 paths
app.all("/v1/*", async (_request, reply) => {
  return reply.code(404).send({
    error: {
      message: "Unknown API endpoint. See https://opendum.app/docs for API reference.",
      type: "invalid_request_error",
      code: "unknown_endpoint",
    },
  });
});

// Graceful shutdown
const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
for (const signal of signals) {
  process.on(signal, async () => {
    app.log.info(`Received ${signal}, shutting down...`);
    await app.close();
    process.exit(0);
  });
}

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`Opendum proxy listening on ${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
