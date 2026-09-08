import type { Provider, ProviderRequestOptions } from "./base.js";
import type { ModelRegistry } from "../registry/registry.js";

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
      stream,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
    };

    return await fetch(`${PERCH_APP_URL}${PERCH_CHAT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: stream ? "text/event-stream" : "application/json",
        Authorization: `Bearer ${credentials?.trim()}`,
      },
      body: JSON.stringify(payload),
      signal,
    });
  }
}

export default PerchProvider;
