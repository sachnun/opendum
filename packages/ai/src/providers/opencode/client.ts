import type { Provider, ProviderRequestOptions } from "../base.js";
import type { ModelRegistry } from "../../registry/registry.js";
import {
  OPENCODE_CHAT_COMPLETIONS_ENDPOINT,
  OPENCODE_RESPONSES_ENDPOINT,
  OPENCODE_PUBLIC_API_KEY,
  OPENCODE_CLIENT,
  OPENCODE_USER_AGENT,
  SUPPORTED_OPENCODE_PARAMS,
} from "./constants.js";

export class OpencodeProvider implements Provider {
  public name = "opencode";

  constructor(private registry: ModelRegistry) {}

  isAuthless(): boolean {
    return true;
  }

  async makeRequest(options: ProviderRequestOptions): Promise<Response> {
    const { body, stream, signal } = options;
    const rawModel = String(body.model || "");
    const model = rawModel.startsWith("opencode/")
      ? rawModel.slice("opencode/".length)
      : rawModel;
    const upstreamModel = this.registry.upstreamModelName(model, "opencode");

    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (SUPPORTED_OPENCODE_PARAMS.has(key) && value !== undefined && value !== null) {
        payload[key] = value;
      }
    }
    payload.model = upstreamModel;
    payload.stream = stream;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
      Authorization: `Bearer ${OPENCODE_PUBLIC_API_KEY}`,
      "User-Agent": OPENCODE_USER_AGENT,
      "X-Opencode-Client": OPENCODE_CLIENT,
      "X-Opencode-Project": String(body._projectId || "global"),
      "X-Opencode-Session": String(body._sessionId || `ses_${Math.random().toString(36).slice(2)}`),
      "X-Opencode-Request": String(body._requestId || `msg_${Math.random().toString(36).slice(2)}`),
    };

    const isResponses = this.registry.providerConfigBool(model, "opencode", "responses_api");
    const endpoint = isResponses
      ? OPENCODE_RESPONSES_ENDPOINT
      : OPENCODE_CHAT_COMPLETIONS_ENDPOINT;

    return await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal,
    });
  }
}
