import { type H3Event } from "h3";
import type { ProxyContext } from "../context.js";
import { extractSessionId } from "../core/service.js";
import type { EndpointAdapter } from "../core/types.js";

export async function handleInference(
  event: H3Event,
  context: ProxyContext,
  endpoint: EndpointAdapter
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed = (await event.req.json()) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return new Response(
        JSON.stringify({
          error: { message: "Invalid JSON in request body", type: "invalid_request_error", param: null, code: null },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return new Response(
      JSON.stringify({
        error: { message: "Invalid JSON in request body", type: "invalid_request_error", param: null, code: null },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const authHeader =
    event.req.headers.get("authorization") ?? event.req.headers.get("x-api-key") ?? "";
  const sessionId = extractSessionId(event.req, body);
  return context.service.handle(endpoint, body, authHeader, sessionId, event.req);
}
