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
    level: "info",
  },
  bodyLimit: 10 * 1024 * 1024, // 10 MB
});

// CORS — allow all
await app.register(cors, {
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: "*",
  exposedHeaders: "*",
  credentials: true,
});

// Health check
app.get("/health", async () => {
  return { status: "ok", timestamp: new Date().toISOString() };
});

// Root
app.get("/", async () => {
  return {
    name: "Opendum Proxy",
    version: "1.0.0",
    status: "operational",
    endpoints: {
      chat_completions: "/v1/chat/completions",
      messages: "/v1/messages",
      responses: "/v1/responses",
      models: "/v1/models",
      health: "/health",
    },
  };
});

// V1 root
app.get("/v1", async () => {
  return {
    endpoints: {
      chat_completions: "/v1/chat/completions",
      messages: "/v1/messages",
      responses: "/v1/responses",
      models: "/v1/models",
    },
  };
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
      message: "Unknown API endpoint.",
      type: "invalid_request_error",
      code: "unknown_endpoint",
    },
  });
});

// Global 404
app.setNotFoundHandler(async (_request, reply) => {
  return reply.code(404).send({
    error: {
      message: "Not found.",
      type: "invalid_request_error",
      code: "not_found",
    },
  });
});

// Global error handler
app.setErrorHandler(async (error, _request, reply) => {
  const err = error as { statusCode?: number; message?: string; code?: string };
  const statusCode = err.statusCode ?? 500;
  reply.code(statusCode).send({
    error: {
      message: statusCode >= 500 ? "Internal server error." : (err.message ?? "Unknown error."),
      type: statusCode >= 500 ? "api_error" : "invalid_request_error",
      code: err.code ?? "unknown_error",
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
