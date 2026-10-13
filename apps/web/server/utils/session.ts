import { createError, type RequestEvent } from "nuxt/server";

import { createAuth, type AuthSession } from "~~/lib/auth";

export async function getSessionFromEvent(event: RequestEvent): Promise<AuthSession> {
  return await createAuth().api.getSession({ headers: event.req.headers });
}

export async function requireSession(event: RequestEvent): Promise<NonNullable<AuthSession>> {
  const session = await getSessionFromEvent(event);

  if (!session?.user?.id) {
    throw createError({ status: 401, statusText: "Unauthorized" });
  }

  return session as NonNullable<AuthSession>;
}
