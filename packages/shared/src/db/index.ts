export * from "./schema.js";
export * from "./relations.js";

import { drizzle as drizzleNodePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import * as schema from "./schema.js";
import * as relations from "./relations.js";

const fullSchema = { ...schema, ...relations };

export type Database = NodePgDatabase<typeof fullSchema> & { $client: Pool };

export function createDb(connectionString: string): Database {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  return drizzleNodePg(connectionString, { schema: fullSchema });
}

export { schema };
