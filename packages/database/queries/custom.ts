import { and, asc, eq } from "drizzle-orm";
import { db, type Database } from "../client.js";
import { customProvider, customProviderModel } from "../schema/custom.js";

export async function listCustomProviders(userId: string, database: Database = db) {
  return database
    .select()
    .from(customProvider)
    .where(and(eq(customProvider.userId, userId), eq(customProvider.enabled, true)))
    .orderBy(asc(customProvider.createdAt));
}

export async function getCustomProvider(
  userId: string,
  slug: string,
  database: Database = db
) {
  const [row] = await database
    .select()
    .from(customProvider)
    .where(
      and(
        eq(customProvider.userId, userId),
        eq(customProvider.slug, slug),
        eq(customProvider.enabled, true)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function listCustomProviderModels(providerId: string, database: Database = db) {
  return database
    .select()
    .from(customProviderModel)
    .where(eq(customProviderModel.providerId, providerId))
    .orderBy(asc(customProviderModel.modelId));
}
