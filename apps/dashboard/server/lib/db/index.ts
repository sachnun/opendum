import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import * as schema from "./schema.js";
import * as relations from "./relations.js";

const fullSchema = { ...schema, ...relations };

export type Database = ReturnType<typeof drizzleNodePg<typeof fullSchema>>;
type PgQueryClient = Pick<Client, "query">;

const globalForDb = globalThis as unknown as {
  db: Database | undefined;
  pool: Pool | undefined;
};

function createDb(): Database {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  if (isCloudflareRuntime()) {
    return drizzleNodePg(createCloudflareQueryClient(connectionString), { schema: fullSchema });
  }

  const pool = new Pool({
    connectionString,
    max: Number.parseInt(process.env.POSTGRES_POOL_MAX ?? "1", 10),
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  });
  globalForDb.pool = pool;
  return drizzleNodePg(pool, { schema: fullSchema });
}

function isCloudflareRuntime(): boolean {
  const userAgent = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent;
  const processVersions = process.versions as Record<string, string | undefined>;
  return process.env.NITRO_PRESET === "cloudflare_module" || userAgent === "Cloudflare-Workers" || Boolean(processVersions.workerd);
}

function createCloudflareQueryClient(connectionString: string): PgQueryClient {
  return {
    async query(config, values) {
      const client = new Client({ connectionString });
      await client.connect();

      try {
        return await client.query(config, values);
      } finally {
        await client.end().catch((error) => {
          console.warn("Failed to close Postgres client:", error);
        });
      }
    },
  };
}

export async function createRequestDb(): Promise<{ db: Database; close: () => Promise<void> }> {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const client = new Client({
    connectionString,
  });

  await client.connect();

  return {
    db: drizzleNodePg(client, { schema: fullSchema }),
    close: async () => {
      try {
        await client.end();
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
