import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import * as schema from "@opendum/shared/db";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export type ProxyDB = NodePgDatabase<typeof schema>;

export function openDb(databaseUrl: string): ProxyDB {
  return drizzleNodePg(databaseUrl, { schema });
}

export type ProviderAccount = typeof schema.providerAccount.$inferSelect;
export type ProviderAccountInsert = typeof schema.providerAccount.$inferInsert;
export type UserPointBalance = typeof schema.userPointBalance.$inferSelect;
export type UserSharingSetting = typeof schema.userSharingSetting.$inferSelect;
export type DisabledModel = typeof schema.disabledModel.$inferSelect;
export type ProxyAPIKey = typeof schema.proxyApiKey.$inferSelect;
export type ProxyAPIKeyRateLimit = typeof schema.proxyApiKeyRateLimit.$inferSelect;
export type UsageLog = typeof schema.usageLog.$inferSelect;
export type PointTransaction = typeof schema.pointTransaction.$inferSelect;
export type ProviderAccountModelHealth = typeof schema.providerAccountModelHealth.$inferSelect;
export type ProviderAccountDisabledModel = typeof schema.providerAccountDisabledModel.$inferSelect;

export { schema };
