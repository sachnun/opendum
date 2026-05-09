import type { H3Event } from "h3";

import { createAuth, type AuthSession } from "../../lib/auth";
import { createRequestDb } from "../lib/db";

export async function getSessionFromEvent(event: H3Event): Promise<AuthSession> {
  const { db, close } = await createRequestDb();

  try {
    return await createAuth(db).api.getSession({ headers: event.headers });
  } finally {
    await close();
  }
}

export async function requireSession(event: H3Event): Promise<NonNullable<AuthSession>> {
  const session = await getSessionFromEvent(event);

  if (!session?.user?.id) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  }

  return session as NonNullable<AuthSession>;
}
