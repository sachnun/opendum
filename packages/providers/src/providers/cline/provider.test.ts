import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Registry } from "@opendum/models/runtime";
import { ClineProvider } from "#providers/providers/cline/provider.ts";
import { createTransport } from "#providers/api/http.ts";
import type { FetchLike } from "#providers/api/http.ts";
import type { ProviderRequest } from "#providers/model/types.ts";

type Json = Record<string, unknown>;

function registry(): Registry {
  return { upstreamModelName: (model: string) => model } as unknown as Registry;
}

function request(body: Json, stream = false): ProviderRequest {
  return { account: { id: "a1", userId: "u1", provider: "cline" }, credentials: "tok", body, stream };
}

function recorder(response: Response): { calls: Array<{ url: string; init?: RequestInit }>; fetch: FetchLike } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return response;
    },
  };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

describe("ClineProvider", () => {
  it("exposes the refresh buffer", () => {
    assert.equal(new ClineProvider({ registry: registry(), transport: createTransport(async () => json({})) }).refreshBuffer(), 5 * 60 * 1000);
  });

  it("refreshes credentials", async () => {
    const { fetch } = recorder(json({ data: { accessToken: "at", refreshToken: "rt2" } }));
    const refreshed = await new ClineProvider({ registry: registry(), transport: createTransport(fetch) }).refreshCredentials("rt1", request({}).account);
    assert.equal(refreshed.accessToken, "workos:at");
    assert.equal(refreshed.refreshToken, "rt2");
  });

  it("rejects failed refreshes", async () => {
    await assert.rejects(
      new ClineProvider({ registry: registry(), transport: createTransport(async () => json({}, 500)) }).refreshCredentials("rt", request({}).account),
      /token refresh failed/
    );
    await assert.rejects(
      new ClineProvider({ registry: registry(), transport: createTransport(async () => json({ data: {} })) }).refreshCredentials("rt", request({}).account),
      /empty access token/
    );
  });

  it("posts chat completions with cline headers", async () => {
    const { calls, fetch } = recorder(json({ choices: [] }));
    const provider = new ClineProvider({ registry: registry(), transport: createTransport(fetch) });
    let started = 0;
    const resp = await provider.makeRequest({
      ...request({ model: "cline/gpt-x", messages: [], temperature: 0.5, unknown: 1 }, true),
      onUpstreamResponseStart: () => {
        started += 1;
      },
    });
    assert.equal(resp.status, 200);
    const payload = JSON.parse(calls[0]!.init!.body as string) as Json;
    assert.equal(payload.model, "gpt-x");
    assert.equal(payload.stream, true);
    assert.equal(payload.temperature, 0.5);
    assert.equal("unknown" in payload, false);
    const headers = calls[0]!.init!.headers as Record<string, string>;
    assert.equal(headers["X-CLIENT-TYPE"], "cline-sdk");
    assert.equal(headers.Authorization, "Bearer tok");
    assert.equal(started, 1);
  });
});
