import { defineHandler, type H3, type H3Event } from "h3";
import type { ProxyContext } from "../context.ts";
import { chatCompletionsConfig, messagesConfig, responsesConfig } from "../core/transport/endpoints.ts";
import { extractSessionId } from "../core/service.ts";
import type { EndpointAdapter } from "../core/types.ts";

async function handleInference(
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

export function registerInferenceRoutes(app: H3, context: ProxyContext): void {
  app.post(
    "/v1/chat/completions",
    defineHandler((event) => handleInference(event, context, chatCompletionsConfig()))
  );
  app.post(
    "/v1/messages",
    defineHandler((event) => handleInference(event, context, messagesConfig()))
  );
  app.post(
    "/v1/responses",
    defineHandler((event) => handleInference(event, context, responsesConfig()))
  );
}
