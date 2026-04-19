import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";
import * as relations from "./relations.js";

const fullSchema = { ...schema, ...relations };

type Database = ReturnType<typeof drizzleNodePg<typeof fullSchema>>;

const globalForDb = globalThis as unknown as {
  db: Database | undefined;
  pool: Pool | undefined;
};

function createDb(): Database {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new Pool({ connectionString });
  globalForDb.pool = pool;
  return drizzleNodePg(pool, { schema: fullSchema });
}

export const db: Database = globalForDb.db ?? createDb();

export async function closeDb() {
  await globalForDb.pool?.end();
  globalForDb.pool = undefined;
}

if (process.env.NODE_ENV !== "production") {
  globalForDb.db = db;
}

// Re-export schema for convenience
export { schema };
