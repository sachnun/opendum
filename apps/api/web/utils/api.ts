import { getQuery, HTTPError, readBody, type H3Event } from "h3";
import { ZodError } from "zod";
import type { z } from "zod";

import { requireSession } from "./session.js";
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

export async function requireContext(event: H3Event): Promise<RequestContext> {
  const claims = await requireSession(event);
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

export async function requireMaintainerContext(event: H3Event): Promise<RequestContext> {
  const context = await requireContext(event);
  if (!context.isMaintainer) {
    throw new HTTPError({ status: 403, statusText: "Maintainer access required" });
  }

  return context;
}

export async function requireReadContext(event: H3Event): Promise<RequestContext> {
  return requireContext(event);
}

export async function requireReadableUserId(event: H3Event): Promise<string> {
  return (await requireReadContext(event)).userId;
}

async function requireWriteContext(event: H3Event, allowAudit = false): Promise<RequestContext> {
  const context = await requireContext(event);
  if (context.isAuditMode && !allowAudit) {
    throw new HTTPError({ status: 403, statusText: "Audit mode is read-only" });
  }

  return context;
}

export async function requireWritableUserId(event: H3Event): Promise<string> {
  return (await requireWriteContext(event)).userId;
}

export async function requireAuditWritableUserId(event: H3Event): Promise<string> {
  return (await requireWriteContext(event, true)).userId;
}

function badRequestFromZod(error: ZodError): never {
  const message = error.issues[0]?.message ?? "Invalid request";
  throw new HTTPError({ status: 400, statusText: message });
}

export async function parseBody<TSchema extends z.ZodType>(
  event: H3Event,
  schema: TSchema
): Promise<z.output<TSchema>> {
  try {
    return schema.parse(await readBody(event));
  } catch (error) {
    if (error instanceof ZodError) badRequestFromZod(error);
    throw error;
  }
}

export function parseQuery<TSchema extends z.ZodType>(
  event: H3Event,
  schema: TSchema
): z.output<TSchema> {
  try {
    return schema.parse(getQuery(event));
  } catch (error) {
    if (error instanceof ZodError) badRequestFromZod(error);
    throw error;
  }
}
