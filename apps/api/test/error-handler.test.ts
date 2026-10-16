import { describe, expect, it } from "bun:test";
import { HTTPError, mockEvent } from "h3";
import errorHandler from "../error.js";
import { errorEnvelope, formatForPath, isInferencePath } from "../handlers/errors.js";

const fallback = () => ({ status: 500 });

function unhandled(message: string): HTTPError {
  const error = new HTTPError(message);
  Object.defineProperty(error, "unhandled", { value: true });
  return error;
}

describe("error envelopes", () => {
  it("formats openai errors with the error object", () => {
    expect(errorEnvelope("openai", "boom", "api_error")).toEqual({
      error: { message: "boom", type: "api_error", param: null, code: null },
    });
  });

  it("keeps the openai param and code when present", () => {
    expect(errorEnvelope("openai", "bad model", "invalid_request_error", { param: "model", code: "invalid_model" }))
      .toEqual({
        error: { message: "bad model", type: "invalid_request_error", param: "model", code: "invalid_model" },
      });
  });

  it("formats anthropic errors with the error envelope", () => {
    expect(errorEnvelope("anthropic", "boom", "api_error")).toEqual({
      type: "error",
      error: { type: "api_error", message: "boom" },
      request_id: null,
    });
  });

  it("selects the anthropic format only for /v1/messages", () => {
    expect(formatForPath("/v1/messages")).toBe("anthropic");
    expect(formatForPath("/v1/chat/completions")).toBe("openai");
    expect(formatForPath("/v1/responses")).toBe("openai");
  });

  it("matches every /v1 path", () => {
    expect(isInferencePath("/v1")).toBe(true);
    expect(isInferencePath("/v1/messages")).toBe(true);
    expect(isInferencePath("/health")).toBe(false);
    expect(isInferencePath("/v10")).toBe(false);
  });
});

describe("nitro error handler", () => {
  it("converts an unhandled error into an openai error body", async () => {
    const response = (await errorHandler(
      unhandled("kaboom"),
      mockEvent("/v1/chat/completions"),
      { defaultHandler: fallback }
    )) as Response;
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("api_error");
    expect(body.error.message).toBe("Internal server error");
  });

  it("uses the anthropic envelope for /v1/messages", async () => {
    const response = (await errorHandler(
      unhandled("kaboom"),
      mockEvent("/v1/messages"),
      { defaultHandler: fallback }
    )) as Response;
    expect(response.status).toBe(500);
    const body = (await response.json()) as { type: string; error: { type: string; message: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("api_error");
    expect(body.error.message).toBe("Internal server error");
  });

  it("preserves a handled HTTPError status and message", async () => {
    const error = new HTTPError({ status: 404, message: "No such route" });
    const response = (await errorHandler(error, mockEvent("/v1/chat/completions"), {
      defaultHandler: fallback,
    })) as Response;
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toBe("No such route");
  });

  it("maps handled 5xx errors to api_error", async () => {
    const error = new HTTPError({ status: 503, message: "Service down" });
    const response = (await errorHandler(error, mockEvent("/v1/chat/completions"), {
      defaultHandler: fallback,
    })) as Response;
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { type: string } };
    expect(body.error.type).toBe("api_error");
  });

  it("ignores non inference paths", async () => {
    const response = await errorHandler(unhandled("kaboom"), mockEvent("/health"), {
      defaultHandler: fallback,
    });
    expect(response).toBeUndefined();
  });
});
