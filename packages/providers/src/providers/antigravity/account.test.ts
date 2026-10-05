import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchAccountInfo, setGoogleHeaders } from "#providers/providers/antigravity/account.ts";
import { ANTIGRAVITY_DEFAULT_PROJECT, type AntigravityRuntime } from "#providers/providers/antigravity/runtime.ts";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function runtime(handler: (url: string) => Response | Promise<Response>): AntigravityRuntime {
  return {
    transport: {
      direct: async (url: string) => handler(url),
    },
  } as unknown as AntigravityRuntime;
}

describe("setGoogleHeaders", () => {
  it("sets auth and client headers", () => {
    const headers: Record<string, string> = {};
    setGoogleHeaders(headers, " token ", true);
    assert.equal(headers.Authorization, "Bearer token");
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(headers.Accept, "text/event-stream");
    assert.ok(headers["User-Agent"]);
    assert.ok(headers["X-Goog-Api-Client"]);
    assert.ok(headers["Client-Metadata"]);
  });
});

describe("fetchAccountInfo", () => {
  it("reads project, tier and email", async () => {
    const rt = runtime((url) => {
      if (url.includes("loadCodeAssist")) return json({ cloudaicompanionProject: "proj", currentTier: { id: "Free-Tier" } });
      if (url.includes("userinfo")) return json({ email: "a@b.c" });
      return json({}, 404);
    });
    const info = await fetchAccountInfo(rt, "token");
    assert.deepEqual(info, { projectId: "proj", tier: "free-tier", paidTier: "", email: "a@b.c" });
  });

  it("reads nested project ids and paid tiers", async () => {
    const rt = runtime((url) => {
      if (url.includes("loadCodeAssist")) {
        return json({ cloudaicompanionProject: { id: "pobj" }, allowedTiers: [{ id: "free-tier", isDefault: true }], paidTier: { id: "standard-tier" } });
      }
      return json({}, 404);
    });
    const info = await fetchAccountInfo(rt, "token");
    assert.equal(info.projectId, "pobj");
    assert.equal(info.tier, "standard-tier");
  });

  it("derives tier from currentTier name", async () => {
    const rt = runtime((url) => {
      if (url.includes("loadCodeAssist")) return json({ currentTier: { name: "Pro" } });
      return json({}, 404);
    });
    const info = await fetchAccountInfo(rt, "token");
    assert.equal(info.tier, "pro");
    assert.equal(info.email, "");
  });

  it("onboards when no project is returned", async () => {
    const rt = runtime((url) => {
      if (url.includes("loadCodeAssist")) return json({ allowedTiers: [{ id: "legacy-tier" }] });
      if (url.includes("onboardUser")) return json({ done: true, response: { cloudaicompanionProject: "p2" } });
      return json({}, 404);
    });
    const info = await fetchAccountInfo(rt, "token");
    assert.equal(info.projectId, "p2");
    assert.equal(info.tier, "legacy-tier");
  });

  it("skips onboarding without allowed tiers", async () => {
    const rt = runtime((url) => {
      if (url.includes("loadCodeAssist")) return json({ currentTier: { id: "free-tier" } });
      return json({}, 404);
    });
    const info = await fetchAccountInfo(rt, "token");
    assert.equal(info.projectId, "");
    assert.equal(info.tier, "free-tier");
  });

  it("detects the default allowed tier", async () => {
    const rt = runtime((url) => {
      if (url.includes("loadCodeAssist")) return json({ allowedTiers: [{ id: "standard-tier", isDefault: true }] });
      if (url.includes("onboardUser")) return json({ done: true, response: { cloudaicompanionProject: "p3" } });
      return json({}, 404);
    });
    const info = await fetchAccountInfo(rt, "token");
    assert.equal(info.projectId, "p3");
  });

  it("falls back to the default project after errors", async () => {
    const rt = runtime((url) => (url.includes("loadCodeAssist") ? json({}, 500) : json({ email: "x@y.z" })));
    const info = await fetchAccountInfo(rt, "token");
    assert.equal(info.projectId, ANTIGRAVITY_DEFAULT_PROJECT);
    assert.equal(info.email, "x@y.z");
  });

  it("survives thrown transport errors", async () => {
    const rt = runtime(() => {
      throw new Error("network down");
    });
    const info = await fetchAccountInfo(rt, "token");
    assert.equal(info.projectId, ANTIGRAVITY_DEFAULT_PROJECT);
    assert.equal(info.email, "");
  });
});
