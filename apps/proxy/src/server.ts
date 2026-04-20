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

function formatOpenAIStyleError(message: string) {
  return {
    error: {
      message,
      type: "invalid_request_error",
      param: null,
      code: null,
    },
  };
}

function formatGlobalError(
  message: string,
  type: "invalid_request_error" | "api_error",
  code: string | null = null
) {
  return {
    error: {
      message,
      type,
      param: null,
      code,
    },
  };
}

// CORS — allow all
await app.register(cors, {
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: "*",
  exposedHeaders: "*",
  credentials: true,
});

// Root
app.get("/", async (_request, reply) => {
  return reply.redirect("/v1", 308);
});

// V1 root
app.get("/v1", async (_request, reply) => {
  return reply.code(404).send(formatOpenAIStyleError("Unknown API endpoint."));
});

// Proxy routes
app.post("/v1/chat/completions", chatCompletionsRoute);
app.post("/v1/messages", messagesRoute);
app.post("/v1/responses", responsesRoute);
app.get("/v1/models", modelsRoute);

// 404 for unknown v1 paths
app.all("/v1/*", async (_request, reply) => {
  return reply.code(404).send(formatOpenAIStyleError("Unknown API endpoint."));
});

// Global 404
app.setNotFoundHandler(async (_request, reply) => {
  return reply.code(404).send(formatOpenAIStyleError("Not Found"));
});

// Global error handler
app.setErrorHandler(async (error, _request, reply) => {
  const err = error as { statusCode?: number; message?: string; code?: string };
  const statusCode = err.statusCode ?? 500;
  reply.code(statusCode).send(
    formatGlobalError(
      statusCode >= 500 ? "Internal server error." : (err.message ?? "Unknown error."),
      statusCode >= 500 ? "api_error" : "invalid_request_error",
      err.code ?? null
    )
  );
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
