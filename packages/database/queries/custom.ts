import { and, asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import { db, type DbExecutor } from "../client.js";
import { tryDb } from "../errors.js";
import { customProvider, customProviderModel } from "../schema/custom.js";

export const listCustomProviders = Effect.fn("db.listCustomProviders")(function* (
  userId: string,
  database: DbExecutor = db
) {
  return yield* tryDb("listCustomProviders", () =>
    database
      .select()
      .from(customProvider)
      .where(and(eq(customProvider.userId, userId), eq(customProvider.enabled, true)))
      .orderBy(asc(customProvider.createdAt))
  );
});

export const getCustomProvider = Effect.fn("db.getCustomProvider")(function* (
  userId: string,
  slug: string,
  database: DbExecutor = db
) {
  const rows = yield* tryDb("getCustomProvider", () =>
    database
      .select()
      .from(customProvider)
      .where(
        and(
          eq(customProvider.userId, userId),
          eq(customProvider.slug, slug),
          eq(customProvider.enabled, true)
        )
      )
      .limit(1)
  );
  return rows[0] ?? null;
});

export const listCustomProviderModels = Effect.fn("db.listCustomProviderModels")(function* (
  providerId: string,
  database: DbExecutor = db
) {
  return yield* tryDb("listCustomProviderModels", () =>
    database
      .select()
      .from(customProviderModel)
      .where(eq(customProviderModel.providerId, providerId))
      .orderBy(asc(customProviderModel.modelId))
  );
});
