import { Effect } from "effect";
import { OAuthError, OAuthErrorCode, type AuthInfo } from "@modelcontextprotocol/server";
import { verifyAccessTokenRequest } from "better-auth/oauth2";
import type { JWTPayload } from "jose";
import { getLocalJwksSource } from "@better-auth/oauth-provider/internal";
import { raise } from "@opendum/platform/raise";
import type { ModelIdentity } from "@opendum/api/handlers/model-listing";
import type { McpContext } from "@opendum/api/mcp/types";
import { getIdentity, type IdentityService } from "@opendum/api/web/identity";
import { mcpResourceUrl, oauthIssuer } from "@opendum/api/web/lib/oauth";

const AUTH_TTL_SECONDS = 3600;
const VERIFIER_TTL_MS = 5 * 60 * 1000;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

type KeyExtra = {
  userId?: string;
  modelAccessMode?: string;
  modelAccessList?: string[];
  roamingEnabled?: boolean;
};

type OauthVerifier = (token: string) => Promise<JWTPayload | null>;
type IdentitySource = () => Promise<IdentityService>;

const defaultIdentitySource: IdentitySource = () => Effect.runPromise(getIdentity());

const identityState: { current?: IdentitySource } = {};
const verifierState: { current?: { verifier: OauthVerifier; at: number } } = {};

export function setIdentitySource(source: IdentitySource | null): void {
  identityState.current = source ?? undefined;
  verifierState.current = undefined;
}

async function oauthVerifier(): Promise<OauthVerifier> {
  const now = Date.now();
  const cached = verifierState.current;
  if (cached && now - cached.at < VERIFIER_TTL_MS) return cached.verifier;

  const identity = await (identityState.current ?? defaultIdentitySource)();
  const authContext = await identity.auth.$context;
  const localJwks = getLocalJwksSource(authContext as unknown as Parameters<typeof getLocalJwksSource>[0]);
  const issuer = oauthIssuer();
  const audience = mcpResourceUrl(issuer);
  const verify = (token: string) =>
    verifyAccessTokenRequest(
      { authorizationHeader: `Bearer ${token}`, method: "POST", url: audience },
      {
        verifyOptions: { issuer, audience, requiredClaims: ["azp"] },
        ...localJwks,
      }
    ).catch(() => null);

  verifierState.current = { verifier: verify, at: now };
  return verify;
}

export async function verifyOpendumToken(context: McpContext, token: string): Promise<AuthInfo> {
  const oauth = await verifyOpendumAccessToken(token);
  if (oauth) return oauth;
  return verifyOpendumKey(context, token);
}

export async function verifyOpendumAccessToken(token: string): Promise<AuthInfo | null> {
  if (!JWT_SHAPE.test(token)) return null;
  const verify = await oauthVerifier();
  const payload = await verify(token);
  if (!payload) return null;

  const sub = payload.sub;
  if (typeof sub !== "string" || sub.length === 0) return null;

  return {
    token,
    clientId: typeof payload.azp === "string" ? payload.azp : "",
    scopes: scopesOf(payload),
    expiresAt: typeof payload.exp === "number" ? payload.exp : undefined,
    extra: {
      userId: sub,
      modelAccessMode: "all",
      modelAccessList: [],
      roamingEnabled: false,
    },
  };
}

export async function verifyOpendumKey(context: McpContext, token: string): Promise<AuthInfo> {
  const result = await Effect.runPromise(context.auth.validateKey(token));
  if (!result.valid) {
    raise(new OAuthError(OAuthErrorCode.InvalidToken, result.error || "Invalid API key"));
  }
  return {
    token,
    clientId: result.apiKeyId || result.userId,
    scopes: ["opendum:mcp"],
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

function scopesOf(payload: JWTPayload): string[] {
  return typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [];
}
