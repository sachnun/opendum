import type { H3Event } from "h3";
import { createError, deleteCookie, getCookie, getQuery, readBody, setCookie } from "h3";
import { eq } from "drizzle-orm";
import { ZodError } from "zod";
import type { z } from "zod";

import { requireSession } from "./session";
import { getDashboardRoleForEmail, type DashboardUserRole } from "./maintainers";
import { db } from "../lib/db";
import { user } from "../lib/db/schema";

export const AUDIT_COOKIE_NAME = "__AuditUser";

export interface DashboardActorUser {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

export interface DashboardRequestContext {
  actor: DashboardActorUser;
  role: DashboardUserRole;
  isMaintener: boolean;
  userId: string;
  auditUser: DashboardActorUser | null;
  isAuditMode: boolean;
}

export type ActionResult<T = void> =
  | { success: true; data: T }
  | { success: false; error: string };

function toDashboardActorUser(value: { id: string; name?: string | null; email?: string | null; image?: string | null }): DashboardActorUser {
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

export function setAuditUserCookie(event: H3Event, userId: string) {
  setCookie(event, AUDIT_COOKIE_NAME, userId, {
    ...auditCookieOptions(),
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function clearAuditUserCookie(event: H3Event) {
  deleteCookie(event, AUDIT_COOKIE_NAME, auditCookieOptions());
}

async function getAuditTargetUser(event: H3Event, actorId: string, isMaintener: boolean): Promise<DashboardActorUser | null> {
  const auditUserId = getCookie(event, AUDIT_COOKIE_NAME)?.trim();
  if (!auditUserId || !isMaintener) return null;

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

export async function requireDashboardContext(event: H3Event): Promise<DashboardRequestContext> {
  const session = await requireSession(event);
  const role = getDashboardRoleForEmail(session.user.email);
  const actor = toDashboardActorUser(session.user);
  const isMaintener = role === "maintener";
  const auditUser = await getAuditTargetUser(event, actor.id, isMaintener);

  return {
    actor,
    role,
    isMaintener,
    userId: auditUser?.id ?? actor.id,
    auditUser,
    isAuditMode: Boolean(auditUser),
  };
}

export async function requireMaintenerContext(event: H3Event): Promise<DashboardRequestContext> {
  const context = await requireDashboardContext(event);
  if (!context.isMaintener) {
    throw createError({ statusCode: 403, statusMessage: "Maintener access required" });
  }

  return context;
}

export async function requireReadableDashboardContext(event: H3Event): Promise<DashboardRequestContext> {
  return requireDashboardContext(event);
}

export async function requireReadableUserId(event: H3Event): Promise<string> {
  return (await requireReadableDashboardContext(event)).userId;
}

export async function requireWritableDashboardContext(event: H3Event): Promise<DashboardRequestContext> {
  const context = await requireDashboardContext(event);
  if (context.isAuditMode) {
    throw createError({ statusCode: 403, statusMessage: "Audit mode is read-only" });
  }

  return context;
}

export async function requireWritableUserId(event: H3Event): Promise<string> {
  return (await requireWritableDashboardContext(event)).userId;
}

export async function requireUserId(event: H3Event): Promise<string> {
  return requireWritableUserId(event);
}

function badRequestFromZod(error: ZodError): never {
  const message = error.issues[0]?.message ?? "Invalid request";
  throw createError({ statusCode: 400, statusMessage: message });
}

export async function readDashboardBody<TSchema extends z.ZodType>(
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

export function getDashboardQuery<TSchema extends z.ZodType>(
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
