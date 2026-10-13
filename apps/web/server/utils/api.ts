import { createError, deleteCookie, getCookie, getQuery, readBody, setCookie, type RequestEvent } from "nuxt/server";
import { eq } from "drizzle-orm";
import { ZodError } from "zod";
import type { z } from "zod";

import { requireSession } from "./session";
import { roleForEmail, type UserRole } from "./maintainers";
import { db, user } from "@opendum/database";

export const AUDIT_COOKIE_NAME = "__AuditUser";

export interface ActorUser {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

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

function toActorUser(value: { id: string; name?: string | null; email?: string | null; image?: string | null }): ActorUser {
  return {
    id: value.id,
    name: value.name ?? null,
    email: value.email ?? null,
    image: value.image ?? null,
  };
}

function auditCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
  };
}

export function setAuditUserCookie(event: RequestEvent, userId: string) {
  setCookie(event, AUDIT_COOKIE_NAME, userId, {
    ...auditCookieOptions(),
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function clearAuditUserCookie(event: RequestEvent) {
  deleteCookie(event, AUDIT_COOKIE_NAME, auditCookieOptions());
}

async function getAuditTargetUser(event: RequestEvent, actorId: string, isMaintainer: boolean): Promise<ActorUser | null> {
  const auditUserId = getCookie(event, AUDIT_COOKIE_NAME)?.trim();
  if (!auditUserId || !isMaintainer) return null;

  if (auditUserId === actorId) {
    clearAuditUserCookie(event);
    return null;
  }

  const [targetUser] = await db
    .select({ id: user.id, name: user.name, email: user.email, image: user.image })
    .from(user)
    .where(eq(user.id, auditUserId))
    .limit(1);

  if (!targetUser) {
    clearAuditUserCookie(event);
    return null;
  }

  return targetUser;
}

export async function requireContext(event: RequestEvent): Promise<RequestContext> {
  const session = await requireSession(event);
  const role = roleForEmail(session.user.email);
  const actor = toActorUser(session.user);
  const isMaintainer = role === "maintainer";
  const auditUser = await getAuditTargetUser(event, actor.id, isMaintainer);

  return {
    actor,
    role,
    isMaintainer,
    userId: auditUser?.id ?? actor.id,
    auditUser,
    isAuditMode: Boolean(auditUser),
  };
}

export async function requireMaintainerContext(event: RequestEvent): Promise<RequestContext> {
  const context = await requireContext(event);
  if (!context.isMaintainer) {
    throw createError({ status: 403, statusText: "Maintainer access required" });
  }

  return context;
}

export async function requireReadContext(event: RequestEvent): Promise<RequestContext> {
  return requireContext(event);
}

export async function requireReadableUserId(event: RequestEvent): Promise<string> {
  return (await requireReadContext(event)).userId;
}

async function requireWriteContext(event: RequestEvent, allowAudit = false): Promise<RequestContext> {
  const context = await requireContext(event);
  if (context.isAuditMode && !allowAudit) {
    throw createError({ status: 403, statusText: "Audit mode is read-only" });
  }

  return context;
}

export async function requireWritableUserId(event: RequestEvent): Promise<string> {
  return (await requireWriteContext(event)).userId;
}

export async function requireAuditWritableUserId(event: RequestEvent): Promise<string> {
  return (await requireWriteContext(event, true)).userId;
}

function badRequestFromZod(error: ZodError): never {
  const message = error.issues[0]?.message ?? "Invalid request";
  throw createError({ status: 400, statusText: message });
}

export async function parseBody<TSchema extends z.ZodType>(
  event: RequestEvent,
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
  event: RequestEvent,
  schema: TSchema
): z.output<TSchema> {
  try {
    return schema.parse(getQuery(event));
  } catch (error) {
    if (error instanceof ZodError) badRequestFromZod(error);
    throw error;
  }
}
