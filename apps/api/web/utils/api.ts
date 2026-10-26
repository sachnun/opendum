import { Effect } from "effect";

import { sessionFrom } from "@opendum/api/web/utils/session";
import { roleOf, type UserRole } from "@opendum/api/web/utils/maintainers";
import type { AuthUser } from "@opendum/api/web/lib/claims";
import { findUser } from "@opendum/api/web/services/users";

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

  const found = yield* findUser(impersonatedBy);
  return found ?? claims;
});

export const contextOf = Effect.fn("contextOf")(function* (
  headers: Headers
) {
  const claims = yield* sessionFrom(headers);
  const impersonatedBy =
    claims.impersonatedBy && claims.impersonatedBy !== claims.user.id ? claims.impersonatedBy : null;
  const actor = yield* resolveActor(claims.user, impersonatedBy);
  const role = roleOf(actor.email);
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
