import { Effect } from "effect";
import { eq } from "drizzle-orm";

import { db, user } from "@opendum/database";
import { toAuthUser, type AuthUser } from "#web/lib/claims.js";
import { fromPromise } from "#web/lib/task.js";

export const findUserById = Effect.fn("findUserById")(function* (userId: string) {
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
  return found ? toAuthUser(found) : null;
}) satisfies (userId: string) => Effect.Effect<AuthUser | null, import("#web/errors.js").ServiceFailure>;
