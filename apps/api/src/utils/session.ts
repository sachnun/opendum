import type { Context } from "hono";
import { createError } from "./errors.js";
import { createAuth, type AuthSession } from "../lib/auth.js";
import { createRequestDb } from "../lib/db/index.js";

export async function getSessionFromRequest(c: Context): Promise<AuthSession> {
  const { db, close } = await createRequestDb();

  try {
    return await createAuth(db).api.getSession({ headers: c.req.raw.headers });
  } finally {
    await close();
  }
}

export async function requireSession(c: Context): Promise<NonNullable<AuthSession>> {
  const session = await getSessionFromRequest(c);

  if (!session?.user?.id) {
    throw createError(401, "Unauthorized");
  }

  return session as NonNullable<AuthSession>;
}
