import type { Provider, ProviderRequestOptions } from "./base.js";
import type { ModelRegistry } from "../registry/registry.js";
import { createPerchSSEToChatTransformer } from "../protocol/responses/perch-stream.js";

const PERCH_APP_URL = "https://app.perchai.app";
const PERCH_CHAT_PATH = "/api/perch-terminal/model-call";

export class PerchProvider implements Provider {
  public name = "perch";

  constructor(private registry: ModelRegistry) {}

  async makeRequest(options: ProviderRequestOptions): Promise<Response> {
    const { credentials, body, stream, signal } = options;
    const rawModel = String(body.model || "");
    const upstreamModel = this.registry.upstreamModelName(rawModel, "perch");

    const payload = {
      model: upstreamModel,
      messages: body.messages,
      stream: true,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
    };

    const upstreamResp = await fetch(`${PERCH_APP_URL}${PERCH_CHAT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${credentials?.trim()}`,
      },
      body: JSON.stringify(payload),
      signal,
    });

    if (!upstreamResp.ok || !upstreamResp.body) {
      return upstreamResp;
    }

    if (stream) {
      const reader = upstreamResp.body.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let sseBuffer = "";

      const outStream = new ReadableStream({
        async pull(controller) {
          const transformer = createPerchSSEToChatTransformer(rawModel, {
            onChunk(chunk) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            },
            onDone() {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            },
          });

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                controller.close();
                return;
              }

              sseBuffer += decoder.decode(value, { stream: true });
              const lines = sseBuffer.split("\n");
              sseBuffer = lines.pop() ?? "";

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("data:")) continue;
                const raw = trimmed.slice(5).trim();
                if (!raw || raw === "[DONE]") continue;

                try {
                  const event = JSON.parse(raw);
                  transformer.processEvent(event);
                } catch {
                  // ignore
                }
              }
            }
          } catch (err) {
            controller.error(err);
          }
        },
      });

      return new Response(outStream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    return upstreamResp;
  }
}

export default PerchProvider;
