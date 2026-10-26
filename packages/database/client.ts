import { SQL } from "bun";
import { drizzle, type BunSQLDatabase } from "drizzle-orm/bun-sql";
import * as relations from "./relations.js";
import * as schema from "./schema/index.js";

export const fullSchema = { ...schema, ...relations };

export type Database = BunSQLDatabase<typeof fullSchema> & { $client: SQL };

export type DbExecutor = Pick<Database, "select" | "insert" | "update" | "delete" | "transaction">;

const globalForDb = globalThis as unknown as {
  db: Database | undefined;
};

const MAX_CONNECTIONS = 10;

function connectionString(): string {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  return connectionString;
}

function createDb(): Database {
  return drizzle({
    connection: {
      url: connectionString(),
      max: MAX_CONNECTIONS,
      prepare: false,
    },
    schema: fullSchema,
  });
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
  await current.$client.close();
}
