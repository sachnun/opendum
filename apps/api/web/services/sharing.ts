import { Effect } from "effect";
import { eq } from "drizzle-orm";

import { db, userSharingSetting } from "@opendum/database";
import { fromPromise } from "#web/lib/task.js";

export const sharingEnabled = Effect.fn("sharingEnabled")(function* (userId: string) {
  const rows = yield* fromPromise(
    () =>
      db
        .select({ enabled: userSharingSetting.enabled })
        .from(userSharingSetting)
        .where(eq(userSharingSetting.userId, userId))
        .limit(1),
    "Failed to load sharing setting"
  );

  return rows[0]?.enabled ?? false;
});

export const setSharing = Effect.fn("setSharing")(function* (
  userId: string,
  enabled: boolean
) {
  const rows = yield* fromPromise(
    () =>
      db
        .insert(userSharingSetting)
        .values({ userId, enabled })
        .onConflictDoUpdate({
          target: userSharingSetting.userId,
          set: { enabled, updatedAt: new Date() },
        })
        .returning({ enabled: userSharingSetting.enabled }),
    "Failed to save sharing setting"
  );

  return { enabled: rows[0]?.enabled ?? enabled };
});
