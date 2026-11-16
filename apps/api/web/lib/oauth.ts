import { Result } from "effect";
import { raise } from "@opendum/platform/raise";

export const MCP_RESOURCE_PATH = "/mcp";
export const MCP_SCOPE = "opendum:mcp";

export const OAUTH_SCOPES = ["openid", "profile", "offline_access", MCP_SCOPE];

function publicOrigin(configured: string | undefined, name: string): string {
  const source = configured?.trim();
  if (!source) raise(new Error(`${name} is required`));
  const parsed = Result.try({ try: () => new URL(source), catch: () => null });
  if (Result.isFailure(parsed)) raise(new Error(`${name} must be an absolute URL`));
  const url = parsed.success;
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    raise(new Error(`${name} must be an http(s) URL`));
  }
  return url.origin;
}

export function oauthIssuer(baseURL?: string): string {
  return publicOrigin(baseURL ?? process.env.BETTER_AUTH_URL, "BETTER_AUTH_URL");
}

export function mcpResourceUrl(issuer: string): string {
  return `${issuer}${MCP_RESOURCE_PATH}`;
}

export function webOrigin(): string {
  return publicOrigin(process.env.WEB, "WEB");
}
