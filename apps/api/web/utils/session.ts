import { Effect } from "effect";
import { HTTPError, type H3Event } from "h3";

import { claimsFromPayload, toAuthUser, type AccessTokenClaims, type AuthUser } from "#web/lib/claims.js";
import { getIdentity, type IdentityService } from "#web/identity.js";

function unauthorized(): HTTPError {
  return new HTTPError({ status: 401, statusText: "Unauthorized" });
}

function bearerToken(headers: Headers): string | null {
  const header = headers.get("authorization");
  if (!header) return null;

  const [scheme, ...rest] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer") return null;

  const token = rest.join(" ").trim();
  return token || null;
}

function bearerHeaders(token: string): Headers {
  return new Headers({ authorization: `Bearer ${token}` });
}

export async function identityService(): Promise<IdentityService> {
  return await getIdentity();
}

export async function getSessionFromEvent(event: H3Event) {
  const identity = await identityService();
  return await Effect.runPromise(identity.sessionFromHeaders(event.req.headers));
}

export async function mintAccessToken(event: H3Event): Promise<string | null> {
  const identity = await identityService();
  return await Effect.runPromise(identity.accessTokenFromHeaders(event.req.headers));
}

export async function requireSessionToken(event: H3Event): Promise<{ user: AuthUser; sessionToken: string }> {
  const token = bearerToken(event.req.headers);
  if (!token) throw unauthorized();

  const identity = await identityService();
  const session = await Effect.runPromise(identity.sessionFromHeaders(bearerHeaders(token)));
  if (!session?.user?.id) throw unauthorized();

  return { user: toAuthUser(session.user), sessionToken: token };
}

export async function requireSession(event: H3Event): Promise<AccessTokenClaims> {
  const token = bearerToken(event.req.headers);
  if (!token) throw unauthorized();

  const identity = await identityService();
  const payload = await Effect.runPromise(identity.verifyAccessToken(token));
  const claims = claimsFromPayload(payload);

  if (!claims) throw unauthorized();

  return claims;
}
