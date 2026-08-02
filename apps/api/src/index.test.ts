import { describe, expect, it } from "vitest";
import app from "../src/index.js";

describe("api app", () => {
  it("serves /api/health", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("404s unknown api routes", async () => {
    const res = await app.request("/api/nope");
    expect(res.status).toBe(404);
  });
});
