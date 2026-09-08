import type { Provider, ProviderRequestOptions, RefreshedCredentials } from "./base.js";
import type { ModelRegistry } from "../registry/registry.js";
import type { ProviderAccount } from "@opendum/database";

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const CODEX_API_BASE_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_ORIGINATOR = "opencode";
const CODEX_REFRESH_BUFFER_SECONDS = 300;

function parseJwtPayload(token: string): any {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf-8"));
  } catch {
    return null;
  }
}

export class CodexProvider implements Provider {
  public name = "codex";

  constructor(private registry: ModelRegistry) {}

  getRefreshBuffer(): number {
    return CODEX_REFRESH_BUFFER_SECONDS;
  }

  async refreshCredentials(
    refreshToken: string,
    _account: ProviderAccount
  ): Promise<RefreshedCredentials> {
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken.trim(),
      client_id: CODEX_CLIENT_ID,
    });

    const res = await fetch(CODEX_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`codex token refresh failed: ${res.status} ${text}`);
    }

    const data: any = await res.json();
    const jwtClaims = parseJwtPayload(data.access_token) || parseJwtPayload(data.id_token);
    const accountId = jwtClaims?.chatgpt_account_id || jwtClaims?.account_id;
    const tier = jwtClaims?.tier || jwtClaims?.plan || "";

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: new Date(Date.now() + (data.expires_in || 3600) * 1000),
      accountId,
      tier,
    };
  }

  async makeRequest(options: ProviderRequestOptions): Promise<Response> {
    const { account, credentials, body, stream, signal } = options;
    const rawModel = String(body.model || "");
    const upstreamModel = this.registry.upstreamModelName(rawModel, "codex");

    const jwtClaims = parseJwtPayload(credentials || "");
    const accountId = account.accountId || jwtClaims?.chatgpt_account_id || "";

    const headers: Record<string, string> = {
      Authorization: `Bearer ${credentials?.trim()}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      originator: CODEX_ORIGINATOR,
      "User-Agent": "opencode/1.14.28",
    };

    if (accountId) {
      headers["chatgpt-account-id"] = accountId;
    }

    const payload = {
      model: upstreamModel,
      input: body.messages || body.input,
      stream,
      tools: body.tools,
      tool_choice: body.tool_choice,
    };

    return await fetch(CODEX_API_BASE_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal,
    });
  }
}

export default CodexProvider;
