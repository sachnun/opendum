import { drizzle as drizzleNodePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import * as relations from "./relations.js";
import * as schema from "./schema/index.js";

export const fullSchema = { ...schema, ...relations };

export type Database = NodePgDatabase<typeof fullSchema> & { $client: Pool };

/**
 * Query-capable database handle. Satisfied by both the pooled `Database` and
 * the transaction handles passed to `Database.transaction` callbacks, so
 * queries and repositories can run inside a transaction without casts.
 */
export type DbExecutor = Pick<Database, "select" | "insert" | "update" | "delete" | "transaction">;

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
  const db = drizzleNodePg({
    connection: {
      connectionString: getConnectionString(),
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    },
    schema: fullSchema,
  });

  db.$client.on("error", (error) => {
    console.warn("Postgres pool error:", error);
  });

  return db;
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

export async function closeDatabase(): Promise<void> {
  const current = globalForDb.db;
  if (!current) return;
  globalForDb.db = undefined;
  await current.$client.end();
}
