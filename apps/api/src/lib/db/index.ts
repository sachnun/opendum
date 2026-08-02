import { drizzle as drizzleNodePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { createDb as createSharedDb, type Database as SharedDatabase } from "@opendum/shared/db";

export type Database = SharedDatabase;

export { schema } from "@opendum/shared/db";
export * from "@opendum/shared/db";

const globalForDb = globalThis as unknown as {
  __opendumApiDb: Database | undefined;
};

function getConnectionString(): string {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  return connectionString;
}

function createDb(): Database {
  return createSharedDb(getConnectionString()) as Database;
}

export async function createRequestDb(): Promise<{ db: Database; close: () => Promise<void> }> {
  const db = createDb();
  return {
    db,
    close: async () => {
      try {
        await (db.$client as Pool).end();
      } catch (error) {
        console.warn("Failed to close Postgres client:", error);
      }
    },
  };
}

function getDb(): Database {
  if (!globalForDb.__opendumApiDb) {
    globalForDb.__opendumApiDb = createDb();
  }
  return globalForDb.__opendumApiDb;
}

export const db = new Proxy({} as Database, {
  get(_target, property, receiver) {
    return Reflect.get(getDb() as object, property, receiver);
  },
}) as Database;

// Keep NodePgDatabase in scope for type inference (used by drizzle-orm consumers).
export type { NodePgDatabase };
