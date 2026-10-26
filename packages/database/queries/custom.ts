import { and, asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import { db, type DbExecutor } from "@opendum/database/client";
import { tryDb } from "@opendum/database/errors";
import { customProvider, customProviderModel } from "@opendum/database/schema/custom";

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

export const customModels = Effect.fn("db.customModels")(function* (
  providerId: string,
  database: DbExecutor = db
) {
  return yield* tryDb("customModels", () =>
    database
      .select()
      .from(customProviderModel)
      .where(eq(customProviderModel.providerId, providerId))
      .orderBy(asc(customProviderModel.modelId))
  );
});
