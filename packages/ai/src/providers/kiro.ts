import type { Provider, ProviderRequestOptions, RefreshedCredentials } from "./base.js";
import type { ModelRegistry } from "../registry/registry.js";
import type { ProviderAccount } from "@opendum/database";

const KIRO_REFRESH_ENDPOINT = "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken";
const KIRO_API_BASE_URL = "https://q.us-east-1.amazonaws.com/generateAssistantResponse";
const KIRO_REFRESH_BUFFER_SECONDS = 300;

export class KiroProvider implements Provider {
  public name = "kiro";

  constructor(private registry: ModelRegistry) {}

  getRefreshBuffer(): number {
    return KIRO_REFRESH_BUFFER_SECONDS;
  }

  async refreshCredentials(
    refreshToken: string,
    _account: ProviderAccount
  ): Promise<RefreshedCredentials> {
    const res = await fetch(KIRO_REFRESH_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ refreshToken: refreshToken.trim() }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`kiro token refresh failed: ${res.status} ${text}`);
    }

    const data: any = await res.json();
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || refreshToken,
      expiresAt: new Date(Date.now() + (data.expiresIn || 3600) * 1000),
    };
  }

  async makeRequest(options: ProviderRequestOptions): Promise<Response> {
    const { credentials, body, stream, signal } = options;
    const rawModel = String(body.model || "");
    const upstreamModel = this.registry.upstreamModelName(rawModel, "kiro");

    const payload = {
      model: upstreamModel,
      messages: body.messages,
      stream,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
    };

    return await fetch(KIRO_API_BASE_URL, {
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

export default KiroProvider;
