import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema";
import * as relations from "./relations";

const fullSchema = { ...schema, ...relations };

type Database = ReturnType<typeof drizzleNeon<typeof fullSchema>>;

const globalForDb = globalThis as unknown as {
  db: Database | undefined;
};

function createDb(): Database {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    // Fallback to local PGlite when DATABASE_URL is not set
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { drizzle } = require("drizzle-orm/pglite") as typeof import("drizzle-orm/pglite");

    return drizzle({
      connection: { dataDir: ".pglite" },
      schema: fullSchema,
    }) as unknown as Database;
  }

  const sql = neon(connectionString);
  return drizzleNeon(sql, { schema: fullSchema });
}

export const db = globalForDb.db ?? createDb();

if (process.env.NODE_ENV !== "production") {
  globalForDb.db = db;
}

// Re-export schema for convenience
export { schema };
