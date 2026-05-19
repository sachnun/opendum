import { drizzle as drizzleNodePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import * as schema from "./schema.js";
import * as relations from "./relations.js";

const fullSchema = { ...schema, ...relations };

export type Database = NodePgDatabase<typeof fullSchema> & { $client: Pool };

const globalForDb = globalThis as unknown as {
  db: Database | undefined;
};

function getConnectionString(): string {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  return connectionString;
}

function createDb(): Database {
  return drizzleNodePg(getConnectionString(), { schema: fullSchema });
}

export async function createRequestDb(): Promise<{ db: Database; close: () => Promise<void> }> {
  const db = createDb();

  return {
    db,
    close: async () => {
      try {
        await db.$client.end();
      } catch (error) {
        console.warn("Failed to close Postgres client:", error);
      }
    },
  };
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

if (process.env.NODE_ENV !== "production") {
  globalForDb.db ??= getDb();
}

// Re-export schema for convenience
export { schema };
