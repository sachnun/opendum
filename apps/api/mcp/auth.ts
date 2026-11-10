import { Effect } from "effect";
import { OAuthError, OAuthErrorCode, type AuthInfo } from "@modelcontextprotocol/server";
import { raise } from "@opendum/core/raise";
import { jsonResponse } from "@opendum/api/handlers/errors";
import type { ModelIdentity } from "@opendum/api/handlers/model-listing";
import type { McpContext } from "@opendum/api/mcp/types";

export const MCP_SCOPE = "opendum:mcp";

const AUTH_TTL_SECONDS = 3600;

type KeyExtra = {
  userId?: string;
  modelAccessMode?: string;
  modelAccessList?: string[];
  roamingEnabled?: boolean;
};

export async function verifyOpendumKey(context: McpContext, token: string): Promise<AuthInfo> {
  const result = await Effect.runPromise(context.auth.validateKey(token));
  if (!result.valid) {
    raise(new OAuthError(OAuthErrorCode.InvalidToken, result.error || "Invalid API key"));
  }
  return {
    token,
    clientId: result.apiKeyId || result.userId,
    scopes: [MCP_SCOPE],
    expiresAt: Math.floor(Date.now() / 1000) + AUTH_TTL_SECONDS,
    extra: {
      userId: result.userId,
      modelAccessMode: result.modelAccessMode,
      modelAccessList: result.modelAccessList,
      roamingEnabled: result.roamingEnabled,
    },
  };
}

export function identityFromAuthInfo(authInfo: AuthInfo | undefined): ModelIdentity {
  const extra = (authInfo?.extra ?? {}) as KeyExtra;
  return {
    userId: extra.userId ?? "",
    accessMode: extra.modelAccessMode ?? "all",
    accessList: extra.modelAccessList ?? [],
    roamingEnabled: extra.roamingEnabled ?? false,
  };
}

export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  if (url.origin && url.origin !== "null") return url.origin;
  const host = request.headers.get("host") ?? "localhost";
  const forwardedProto = request.headers.get("x-forwarded-proto") ?? "http";
  return `${forwardedProto}://${host}`;
}

export function protectedResourceMetadata(request: Request): Response {
  const body = {
    resource: `${requestOrigin(request)}/mcp`,
    resource_name: "opendum MCP",
    scopes_supported: [MCP_SCOPE],
  };
  return jsonResponse(body, 200, { "cache-control": "no-store" });
}
