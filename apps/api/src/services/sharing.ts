import { eq } from "drizzle-orm";

import { db } from "../lib/db";
import { userSharingSetting } from "../lib/db/schema";

export async function getUserSharingEnabled(userId: string): Promise<boolean> {
  const [setting] = await db
    .select({ enabled: userSharingSetting.enabled })
    .from(userSharingSetting)
    .where(eq(userSharingSetting.userId, userId))
    .limit(1);

  return setting?.enabled ?? false;
}

export async function setUserSharingEnabled(userId: string, enabled: boolean): Promise<{ enabled: boolean }> {
  const [updated] = await db
    .insert(userSharingSetting)
    .values({ userId, enabled })
    .onConflictDoUpdate({
      target: userSharingSetting.userId,
      set: { enabled, updatedAt: new Date() },
    })
    .returning({ enabled: userSharingSetting.enabled });

  return { enabled: updated?.enabled ?? enabled };
}
