import { Effect } from "effect";
import type { H3Event } from "h3";

import { claimsOf, authUser, type AccessTokenClaims } from "#web/lib/claims.js";
import { unauthorized } from "#web/errors.js";
import { getIdentity, type IdentityService } from "#web/identity.js";

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

export const identityService = Effect.fn("identityService")(function* () {
  return yield* getIdentity();
});

export const sessionOf = Effect.fn("sessionOf")(function* (event: H3Event) {
  const identity = yield* identityService();
  return yield* identity.sessionFromHeaders(event.req.headers);
});

export const mintAccessToken = Effect.fn("mintAccessToken")(function* (event: H3Event) {
  const identity = yield* identityService();
  return yield* identity.tokenFromHeaders(event.req.headers);
});

export const requireSessionToken = Effect.fn("requireSessionToken")(function* (event: H3Event) {
  const token = bearerToken(event.req.headers);
  if (!token) return yield* unauthorized();

  const identity = yield* identityService();
  const session = yield* identity.sessionFromHeaders(bearerHeaders(token));
  if (!session?.user?.id) return yield* unauthorized();

  return { user: authUser(session.user), sessionToken: token };
});

export const sessionFrom = Effect.fn("sessionFrom")(function* (
  headers: Headers
) {
  const token = bearerToken(headers);
  if (!token) return yield* unauthorized();

  const identity = yield* identityService();
  const payload = yield* identity.verifyAccessToken(token);
  const claims = claimsOf(payload);

  if (!claims) return yield* unauthorized();

  return claims satisfies AccessTokenClaims;
}) as (headers: Headers) => Effect.Effect<AccessTokenClaims, import("#web/errors.js").ServiceFailure>;

export type { IdentityService };
