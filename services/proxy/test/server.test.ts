import { describe, expect, it, mock } from "bun:test";
import { mockEvent } from "h3";
import { createDatabaseQueryMocks } from "./database-mock.js";
import { applyCors, corsPreflight } from "../src/middleware/cors.js";

const db = createDatabaseQueryMocks();
mock.module("@opendum/database/queries", () => db);

const health = (await import("../server/routes/health.get.js")).default;
const index = (await import("../server/routes/index.get.js")).default;
const v1Index = (await import("../server/routes/v1/index.get.js")).default;
const fallback = (await import("../server/routes/[...].js")).default;
const corsMiddleware = (await import("../server/middleware/cors.js")).default;

describe("routes", () => {
  it("reports health", async () => {
    const response = (await health(mockEvent("/health"))) as Response;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("redirects the root to /v1", async () => {
    const response = (await index(mockEvent("/"))) as Response;
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/v1");
  });

  it("returns an unknown endpoint error for /v1", async () => {
    const response = (await v1Index(mockEvent("/v1"))) as Response;
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { message: "Unknown API endpoint." } });
  });

  it("returns an unknown endpoint error for unmatched /v1 paths", async () => {
    const response = (await fallback(mockEvent("/v1/unknown"))) as Response;
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { message: "Unknown API endpoint." } });
  });

  it("returns not found for other unmatched paths", async () => {
    const response = (await fallback(mockEvent("/nope"))) as Response;
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { message: "Not Found" } });
  });
});

describe("cors", () => {
  it("adds cors headers", () => {
    const headers = new Headers();
    applyCors(headers);
    expect(headers.get("access-control-allow-origin")).toBe("*");
    expect(headers.get("access-control-expose-headers")).toBe("*");
  });

  it("answers preflight requests", async () => {
    const response = (await corsMiddleware(mockEvent("/v1/chat/completions", { method: "OPTIONS" }), () =>
      Promise.resolve(new Response(null, { status: 500 }))
    )) as Response;
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("delegates non preflight requests", async () => {
    const response = (await corsMiddleware(mockEvent("/v1/chat/completions", { method: "POST" }), () =>
      Promise.resolve(new Response("ok", { status: 200 }))
    )) as Response;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("builds a preflight response", () => {
    expect(corsPreflight().status).toBe(204);
  });
});
