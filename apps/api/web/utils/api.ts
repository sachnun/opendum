import { Effect } from "effect";

import { requireSessionFromHeaders } from "./session.js";
import { roleForEmail, type UserRole } from "./maintainers.js";
import type { AuthUser } from "#web/lib/claims.js";
import { findUserById } from "#web/services/users.js";

export type ActorUser = AuthUser;

export interface RequestContext {
  actor: ActorUser;
  role: UserRole;
  isMaintainer: boolean;
  userId: string;
  auditUser: ActorUser | null;
  isAuditMode: boolean;
}

export type ActionResult<T = void> =
  | { success: true; data: T }
  | { success: false; error: string };

export const resolveActor = Effect.fn("resolveActor")(function* (
  claims: AuthUser,
  impersonatedBy: string | null
) {
  if (!impersonatedBy) return claims;

  const found = yield* findUserById(impersonatedBy);
  return found ?? claims;
});

export const requireContextFromHeaders = Effect.fn("requireContextFromHeaders")(function* (
  headers: Headers
) {
  const claims = yield* requireSessionFromHeaders(headers);
  const impersonatedBy =
    claims.impersonatedBy && claims.impersonatedBy !== claims.user.id ? claims.impersonatedBy : null;
  const actor = yield* resolveActor(claims.user, impersonatedBy);
  const role = roleForEmail(actor.email);
  const isMaintainer = role === "maintainer";

  return {
    actor,
    role,
    isMaintainer,
    userId: claims.user.id,
    auditUser: impersonatedBy ? claims.user : null,
    isAuditMode: Boolean(impersonatedBy),
  } satisfies RequestContext;
});
