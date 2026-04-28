import type { H3Event } from "h3";

import { auth, type AuthSession } from "../../lib/auth";

export async function getSessionFromEvent(event: H3Event): Promise<AuthSession> {
  return auth.api.getSession({ headers: event.headers });
}

export async function requireSession(event: H3Event): Promise<NonNullable<AuthSession>> {
  const session = await getSessionFromEvent(event);

  if (!session?.user?.id) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  }

  return session as NonNullable<AuthSession>;
}
