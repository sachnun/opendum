import { Hono } from "hono";
import type { ModelRegistry, ProviderRegistry } from "@opendum/ai";
import type { AuthService } from "../auth/service.js";
import { LoadBalancer } from "../proxy/balancer.js";
import { createChatRoute } from "./chat.js";

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown> | string;
}

interface AnthropicMessage {
  role: string;
  content: string | AnthropicContentBlock[];
}

function convertAnthropicToOpenAI(body: any): Record<string, unknown> {
  const messages: any[] = [];

  if (body.system) {
    const systemText =
      typeof body.system === "string"
        ? body.system
        : Array.isArray(body.system)
          ? body.system.map((s: any) => s.text || "").join("\n\n")
          : "";
    if (systemText) {
      messages.push({ role: "system", content: systemText });
    }
  }

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (typeof msg.content === "string") {
        messages.push({ role: msg.role, content: msg.content });
      } else if (Array.isArray(msg.content)) {
        let textParts = "";
        const toolCalls: any[] = [];

        for (const block of msg.content) {
          if (block.type === "text" && block.text) {
            textParts += block.text;
          } else if (block.type === "tool_use") {
            toolCalls.push({
              id: block.id,
              type: "function",
              function: {
                name: block.name,
                arguments:
                  typeof block.input === "string"
                    ? block.input
                    : JSON.stringify(block.input || {}),
              },
            });
          }
        }

        const openAiMsg: any = { role: msg.role, content: textParts };
        if (toolCalls.length > 0) {
          openAiMsg.tool_calls = toolCalls;
        }
        messages.push(openAiMsg);
      }
    }
  }

  return {
    ...body,
    messages,
    max_tokens: body.max_tokens ?? 4096,
  };
}

export function createMessagesRoute(
  authService: AuthService,
  registry: ModelRegistry,
  providers: ProviderRegistry,
  loadBalancer: LoadBalancer
) {
  const router = new Hono();
  const chatRouter = createChatRoute(authService, registry, providers, loadBalancer);

  router.post("/v1/messages", async (c) => {
    const anthropicBody = await c.req.json();
    const openAIBody = convertAnthropicToOpenAI(anthropicBody);

    c.req.raw = new Request(c.req.url, {
      method: "POST",
      headers: c.req.raw.headers,
      body: JSON.stringify(openAIBody),
    });

    return chatRouter.fetch(c.req.raw);
  });

  return router;
}
