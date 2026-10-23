import type { ErrorFormat } from "../core/types.js";

export function jsonResponse(value: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (extraHeaders) {
    for (const [key, val] of Object.entries(extraHeaders)) headers.set(key, val);
  }
  return new Response(JSON.stringify(value), { status, headers });
}

export type ErrorExtras = { param?: string | null; code?: string | null; requestId?: string | null };

export function errorEnvelope(
  format: ErrorFormat,
  message: string,
  type: string,
  extras?: ErrorExtras
): Record<string, unknown> {
  if (format === "anthropic") {
    return {
      type: "error",
      error: { type, message },
      request_id: extras?.requestId ?? null,
    };
  }
  return {
    error: {
      message,
      type,
      param: extras?.param ?? null,
      code: extras?.code ?? null,
    },
  };
}

export function internalErrorResponse(format: ErrorFormat, message = "Internal server error"): Response {
  return jsonResponse(errorEnvelope(format, message, "api_error"), 500);
}

export function unknownEndpoint(): Response {
  return jsonResponse(errorEnvelope("openai", "Unknown API endpoint.", "invalid_request_error"), 404);
}

export function notFound(): Response {
  return jsonResponse(errorEnvelope("openai", "Not Found", "invalid_request_error"), 404);
}

const ANTHROPIC_PATHS = new Set(["/v1/messages"]);

export function formatForPath(pathname: string): ErrorFormat {
  return ANTHROPIC_PATHS.has(pathname) ? "anthropic" : "openai";
}

export function isInferencePath(pathname: string): boolean {
  return pathname === "/v1" || pathname.startsWith("/v1/");
}
