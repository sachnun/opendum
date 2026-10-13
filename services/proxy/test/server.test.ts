import { describe, expect, it, mock } from "bun:test";
import { createDatabaseQueryMocks } from "./database-mock.js";
import type { ProxyContext } from "../src/context.js";

const db = createDatabaseQueryMocks();
mock.module("@opendum/database/queries", () => db);

const { createServer } = await import("../src/server.js");

const context = {} as unknown as ProxyContext;

describe("cors middleware", () => {
  it("adds cors headers to successful responses", async () => {
    const app = createServer(context);
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-expose-headers")).toBe("*");
  });

  it("adds cors headers to not found responses", async () => {
    const app = createServer(context);
    const response = await app.request("/v1/unknown");
    expect(response.status).toBe(404);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("answers preflight requests", async () => {
    const app = createServer(context);
    const response = await app.request("/v1/chat/completions", { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
});
