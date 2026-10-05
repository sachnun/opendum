import type { EndpointAdapter, RouteError } from "./types.ts";

export function routeError(cfg: EndpointAdapter, error: RouteError): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (error.accountId) headers.set("X-Provider-Account-Id", error.accountId);
  if (error.retryAfterMs != null && error.retryAfterMs > 0) {
    headers.set("Retry-After", String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
  }
  if (cfg.format === "anthropic") {
    const body: Record<string, unknown> = { type: error.type || "invalid_request_error", message: error.message };
    if (error.retryAfter != null) body.retry_after = error.retryAfter;
    if (error.retryAfterMs != null) body.retry_after_ms = error.retryAfterMs;
    return new Response(JSON.stringify({ type: "error", error: body }), { status: error.status, headers });
  }
  const body = {
    error: {
      message: error.message,
      type: error.type || "invalid_request_error",
      param: error.param ?? null,
      code: error.code ?? null,
      ...(error.retryAfter != null ? { retry_after: error.retryAfter } : {}),
      ...(error.retryAfterMs != null ? { retry_after_ms: error.retryAfterMs } : {}),
    },
  };
  return new Response(JSON.stringify(body), { status: error.status, headers });
}
