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

function getDb(): Database {
  if (!globalForDb.db) {
    globalForDb.db = createDb();
  }

  return globalForDb.db;
}

export const db = new Proxy({} as Database, {
  get(_target, property, receiver) {
    return Reflect.get(getDb() as object, property, receiver);
  },
}) as Database;

export async function closeDb() {
  await globalForDb.pool?.end();
  globalForDb.pool = undefined;
}

if (process.env.NODE_ENV !== "production") {
  globalForDb.db ??= getDb();
}

// Re-export schema for convenience
export { schema };
