import { Effect } from "effect";
import { eq } from "drizzle-orm";

import { db, user } from "@opendum/database";
import { authUser, type AuthUser } from "@opendum/api/web/lib/claims";
import { fromPromise } from "@opendum/api/web/lib/task";

export const findUser = Effect.fn("findUser")(function* (userId: string) {
  const rows = yield* fromPromise(
    () =>
      db
        .select({ id: user.id, name: user.name, email: user.email, image: user.image })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1),
    "Failed to load user"
  );

  const found = rows[0];
  return found ? authUser(found) : null;
}) satisfies (userId: string) => Effect.Effect<AuthUser | null, import("@opendum/api/web/errors").ServiceFailure>;
