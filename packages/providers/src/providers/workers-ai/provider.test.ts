import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Registry } from "@opendum/models/runtime";
import { WorkersAiProvider } from "#providers/providers/workers-ai/provider.ts";
import { createTransport } from "#providers/api/http.ts";
import type { FetchLike } from "#providers/api/http.ts";
import type { ProviderRequest } from "#providers/model/types.ts";

type Json = Record<string, unknown>;

function registry(): Registry {
  return { upstreamModelName: (model: string) => `up-${model}` } as unknown as Registry;
}

function request(body: Json, stream = false): ProviderRequest {
  return { account: { id: "a1", userId: "u1", provider: "workers_ai", accountId: "acc1" }, credentials: "tok", body, stream };
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

describe("WorkersAiProvider", () => {
  it("requires an account id", async () => {
    const provider = new WorkersAiProvider({ registry: registry(), transport: createTransport(async () => new Response("{}")) });
    await assert.rejects(
      provider.makeRequest({ ...request({ model: "m" }), account: { id: "a1", userId: "u1", provider: "workers_ai" } }),
      /missing Cloudflare Account ID/
    );
  });

  it("posts filtered payloads", async () => {
    const { calls, fetch } = recorder(new Response("{}", { status: 200 }));
    const provider = new WorkersAiProvider({ registry: registry(), transport: createTransport(fetch) });
    let started = 0;
    const resp = await provider.makeRequest({
      ...request(
        {
          model: "@cf/meta/llama",
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }],
          temperature: 0.5,
          unknown: 1,
        },
        true
      ),
      onUpstreamResponseStart: () => {
        started += 1;
      },
    });
    assert.equal(resp.status, 200);
    assert.equal(calls[0]!.url, "https://api.cloudflare.com/client/v4/accounts/acc1/ai/v1/chat/completions");
    const payload = JSON.parse(calls[0]!.init!.body as string) as Json;
    assert.equal(payload.model, "up-@cf/meta/llama");
    assert.equal(payload.stream, true);
    assert.equal(payload.temperature, 0.5);
    assert.equal("unknown" in payload, false);
    assert.equal((payload.messages as Json[]).length, 1);
    assert.equal(started, 1);
  });
});
