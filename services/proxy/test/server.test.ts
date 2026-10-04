import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { ProxyContext } from "../src/context.js";
import { createServer } from "../src/server.js";

const context = {} as unknown as ProxyContext;

describe("cors middleware", () => {
  it("adds cors headers to successful responses", async () => {
    const app = createServer(context);
    const response = await app.request("/health");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("access-control-expose-headers"), "*");
  });

  it("adds cors headers to not found responses", async () => {
    const app = createServer(context);
    const response = await app.request("/v1/unknown");
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  });

  it("answers preflight requests", async () => {
    const app = createServer(context);
    const response = await app.request("/v1/chat/completions", { method: "OPTIONS" });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  });
});
