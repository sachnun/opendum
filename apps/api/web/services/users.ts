import { eq } from "drizzle-orm";

import { db, user } from "@opendum/database";
import { toAuthUser, type AuthUser } from "#web/lib/claims.js";

export async function findUserById(userId: string): Promise<AuthUser | null> {
  const [found] = await db
    .select({ id: user.id, name: user.name, email: user.email, image: user.image })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  return found ? toAuthUser(found) : null;
}
