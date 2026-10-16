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

async function resolveActor(claims: AuthUser, impersonatedBy: string | null): Promise<AuthUser> {
  if (!impersonatedBy) return claims;

  return (await findUserById(impersonatedBy)) ?? claims;
}

export async function requireContextFromHeaders(headers: Headers): Promise<RequestContext> {
  const claims = await requireSessionFromHeaders(headers);
  const impersonatedBy = claims.impersonatedBy && claims.impersonatedBy !== claims.user.id ? claims.impersonatedBy : null;
  const actor = await resolveActor(claims.user, impersonatedBy);
  const role = roleForEmail(actor.email);
  const isMaintainer = role === "maintainer";

  return {
    actor,
    role,
    isMaintainer,
    userId: claims.user.id,
    auditUser: impersonatedBy ? claims.user : null,
    isAuditMode: Boolean(impersonatedBy),
  };
}
