import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { ZodError } from "zod";
import type { z } from "zod";

import { requireSession } from "./session.js";
import { getDashboardRoleForEmail, type DashboardUserRole } from "./maintainers.js";
import { db } from "../lib/db/index.js";
import { user } from "../lib/db/schema.js";
import { createError } from "./errors.js";

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

export function setAuditUserCookie(c: Context, userId: string) {
  setCookie(c, AUDIT_COOKIE_NAME, userId, {
    ...auditCookieOptions(),
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function clearAuditUserCookie(c: Context) {
  deleteCookie(c, AUDIT_COOKIE_NAME, auditCookieOptions());
}

async function getAuditTargetUser(c: Context, actorId: string, isMaintener: boolean): Promise<DashboardActorUser | null> {
  const auditUserId = getCookie(c, AUDIT_COOKIE_NAME)?.trim();
  if (!auditUserId || !isMaintener) return null;

  if (auditUserId === actorId) {
    clearAuditUserCookie(c);
    return null;
  }

  const [targetUser] = await db
    .select({ id: user.id, name: user.name, email: user.email, image: user.image })
    .from(user)
    .where(eq(user.id, auditUserId))
    .limit(1);

  if (!targetUser) {
    clearAuditUserCookie(c);
    return null;
  }

  return targetUser;
}

export async function requireDashboardContext(c: Context): Promise<DashboardRequestContext> {
  const session = await requireSession(c);
  const role = getDashboardRoleForEmail(session.user.email);
  const actor = toDashboardActorUser(session.user);
  const isMaintener = role === "maintener";
  const auditUser = await getAuditTargetUser(c, actor.id, isMaintener);

  return {
    actor,
    role,
    isMaintener,
    userId: auditUser?.id ?? actor.id,
    auditUser,
    isAuditMode: Boolean(auditUser),
  };
}

export async function requireMaintenerContext(c: Context): Promise<DashboardRequestContext> {
  const context = await requireDashboardContext(c);
  if (!context.isMaintener) {
    throw createError(403, "Maintener access required");
  }

  return context;
}

export async function requireReadableDashboardContext(c: Context): Promise<DashboardRequestContext> {
  return requireDashboardContext(c);
}

export async function requireReadableUserId(c: Context): Promise<string> {
  return (await requireReadableDashboardContext(c)).userId;
}

export async function requireWritableDashboardContext(c: Context): Promise<DashboardRequestContext> {
  const context = await requireDashboardContext(c);
  if (context.isAuditMode) {
    throw createError(403, "Audit mode is read-only");
  }

  return context;
}

export async function requireWritableUserId(c: Context): Promise<string> {
  return (await requireWritableDashboardContext(c)).userId;
}

function badRequestFromZod(error: ZodError): never {
  const message = error.issues[0]?.message ?? "Invalid request";
  throw createError(400, message);
}

export async function readDashboardBody<TSchema extends z.ZodType>(
  c: Context,
  schema: TSchema,
): Promise<z.output<TSchema>> {
  try {
    return schema.parse(await c.req.json());
  } catch (error) {
    if (error instanceof ZodError) badRequestFromZod(error);
    throw error;
  }
}

export function getDashboardQuery<TSchema extends z.ZodType>(
  c: Context,
  schema: TSchema,
): z.output<TSchema> {
  try {
    return schema.parse(c.req.query());
  } catch (error) {
    if (error instanceof ZodError) badRequestFromZod(error);
    throw error;
  }
}
