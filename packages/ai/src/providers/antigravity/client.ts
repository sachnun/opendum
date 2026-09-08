import type { Provider, ProviderRequestOptions, RefreshedCredentials } from "../base.js";
import type { ModelRegistry } from "../../registry/registry.js";
import type { ProviderAccount } from "@opendum/database";
import { ANTIGRAVITY_USER_AGENT } from "./version.js";
import {
  GOOGLE_OAUTH_TOKEN_ENDPOINT,
  ANTIGRAVITY_CLAUDE_BETA_HEADER,
} from "./constants.js";

const ANTIGRAVITY_API_ENDPOINT = "https://cloudaicompanion.googleapis.com/v1";

export class AntigravityProvider implements Provider {
  public name = "antigravity";

  constructor(private registry: ModelRegistry) {}

  getRefreshBuffer(): number {
    return 3600;
  }

  async refreshCredentials(
    refreshToken: string,
    _account: ProviderAccount
  ): Promise<RefreshedCredentials> {
    const form = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
      refresh_token: refreshToken.trim(),
      grant_type: "refresh_token",
    });

    const res = await fetch(GOOGLE_OAUTH_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`antigravity token refresh failed: ${res.status} ${text}`);
    }

    const data: any = await res.json();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: new Date(Date.now() + (data.expires_in || 3600) * 1000),
    };
  }

  async makeRequest(options: ProviderRequestOptions): Promise<Response> {
    const { account, credentials, body, stream, signal } = options;
    const rawModel = String(body.model || "");
    const upstreamModel = this.registry.upstreamModelName(rawModel, "antigravity");
    const projectId = account.projectId || "default";

    const headers: Record<string, string> = {
      Authorization: `Bearer ${credentials?.trim()}`,
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
      "User-Agent": ANTIGRAVITY_USER_AGENT,
      "anthropic-beta": ANTIGRAVITY_CLAUDE_BETA_HEADER,
    };

    const url = `${ANTIGRAVITY_API_ENDPOINT}/projects/${projectId}/models/${upstreamModel}:${stream ? "streamGenerateContent" : "generateContent"}`;

    return await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  }
}

export default AntigravityProvider;
