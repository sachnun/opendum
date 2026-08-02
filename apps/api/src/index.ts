import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import "dotenv/config";

import { createAuth } from "./lib/auth.js";
import { createRequestDb } from "./lib/db/index.js";
import { HttpError } from "./utils/errors.js";
import dashboardRoutes from "./routes/index.js";

const app = new Hono();

app.use(logger());
app.use("/api/*", cors({
  origin: (origin) => origin ?? "*",
  credentials: true,
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  exposeHeaders: ["X-Opendum-Internal-Relay-Error"],
}));

// better-auth handler at /api/auth/*
app.all("/api/auth/*", async (c) => {
  const { db, close } = await createRequestDb();
  try {
    const auth = createAuth(db);
    return auth.handler(c.req.raw);
  } finally {
    await close();
  }
});

// Dashboard routes (ported from Nitro server/api/dashboard/**)
app.route("/api/dashboard", dashboardRoutes);

app.get("/api/health", (c) => c.json({ ok: true }));

// Error middleware
app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ message: err.message, statusCode: err.statusCode }, err.statusCode as 400);
  }
  console.error("Unhandled error:", err);
  return c.json({ message: "Internal server error", statusCode: 500 }, 500);
});

app.notFound((c) => c.json({ message: "Not Found", statusCode: 404 }, 404));

const port = Number(process.env.PORT ?? 3001);

if (process.env.NODE_ENV !== "test") {
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`Opendum API listening on http://localhost:${info.port}`);
  });
}

export default app;
