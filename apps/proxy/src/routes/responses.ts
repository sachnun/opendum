import { Hono } from "hono";
import type { ModelRegistry, ProviderRegistry } from "@opendum/ai";
import type { AuthService } from "../auth/service.js";
import { LoadBalancer } from "../proxy/balancer.js";
import { createChatRoute } from "./chat.js";

function convertResponsesToOpenAI(body: any): Record<string, unknown> {
  const messages: any[] = [];

  if (body.instructions) {
    messages.push({ role: "system", content: body.instructions });
  }

  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item.type === "message" || !item.type) {
        messages.push({
          role: item.role || "user",
          content: typeof item.content === "string" ? item.content : JSON.stringify(item.content),
        });
      }
    }
  }

  return {
    ...body,
    messages: messages.length > 0 ? messages : (body.messages || []),
    max_tokens: body.max_output_tokens ?? body.max_tokens ?? 4096,
  };
}

export function createResponsesRoute(
  authService: AuthService,
  registry: ModelRegistry,
  providers: ProviderRegistry,
  loadBalancer: LoadBalancer
) {
  const router = new Hono();
  const chatRouter = createChatRoute(authService, registry, providers, loadBalancer);

  router.post("/v1/responses", async (c) => {
    const responsesBody = await c.req.json();
    const openAIBody = convertResponsesToOpenAI(responsesBody);

    c.req.raw = new Request(c.req.url, {
      method: "POST",
      headers: c.req.raw.headers,
      body: JSON.stringify(openAIBody),
    });

    return chatRouter.fetch(c.req.raw);
  });

  return router;
}
