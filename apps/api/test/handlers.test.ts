import { describe, expect, it } from "bun:test";
import { mockEvent } from "h3";
import type { ProxyContext } from "../core/context.js";
import { Chat, Messages } from "../core/endpoints.js";
import { handleInference } from "../handlers/inference.js";
import { handleModels } from "../handlers/models.js";

function context(overrides: Partial<ProxyContext> = {}): ProxyContext {
  return {
    service: {
      handle: async () => new Response("{}", { status: 200 }),
    },
    ...overrides,
  } as unknown as ProxyContext;
}

function postEvent(path: string, body: string): ReturnType<typeof mockEvent> {
  return mockEvent(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })
  );
}

describe("handleInference", () => {
  it("rejects invalid JSON with an openai envelope", async () => {
    const response = await handleInference(postEvent("/v1/chat/completions", "not json"), context(), new Chat());
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { type: string } };
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("rejects invalid JSON with an anthropic envelope", async () => {
    const response = await handleInference(postEvent("/v1/messages", "not json"), context(), new Messages());
    expect(response.status).toBe(400);
    const body = (await response.json()) as { type: string; error: { type: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("returns a structured 500 when the service throws", async () => {
    const failing = context({
      service: {
        handle: async () => {
          throw new Error("service exploded");
        },
      } as unknown as ProxyContext["service"],
    });
    const response = await handleInference(postEvent("/v1/chat/completions", "{}"), failing, new Chat());
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("api_error");
    expect(body.error.message).toBe("Internal server error");
  });
});

describe("handleModels", () => {
  it("returns a structured 500 when model listing throws", async () => {
    const failing = context({
      auth: {
        validateKey: () => {
          throw new Error("auth exploded");
        },
      } as unknown as ProxyContext["auth"],
    });
    const event = mockEvent(
      new Request("http://localhost/v1/models", {
        method: "POST",
        headers: { authorization: "Bearer key" },
      })
    );
    const response = await handleModels(event, failing);
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("api_error");
    expect(body.error.message).toBe("Failed to list models");
  });
});
