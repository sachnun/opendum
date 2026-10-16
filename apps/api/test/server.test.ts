import { describe, expect, it } from "bun:test";
import { mockEvent } from "h3";
import config from "../nitro.config.js";

const health = (await import("../routes/health.get.js")).default;
const fallback = (await import("../routes/[...].js")).default;

describe("routes", () => {
  it("reports health", async () => {
    const response = (await health(mockEvent("/health"))) as Response;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("returns an unknown endpoint error for /v1", async () => {
    const response = (await fallback(mockEvent("/v1"))) as Response;
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

describe("config", () => {
  it("applies permissive cors to every route", () => {
    expect(config.routeRules?.["/**"]).toMatchObject({
      cors: { origin: "*", methods: ["GET", "POST", "OPTIONS"], allowHeaders: "*", exposeHeaders: "*" },
    });
  });

  it("redirects the root to /v1", () => {
    expect(config.routeRules?.["/"]).toMatchObject({ redirect: { to: "/v1", status: 308 } });
  });
});
