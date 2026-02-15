// Prisma config for Opendum
import "dotenv/config";
import { defineConfig } from "prisma/config";

const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  // Only configure datasource when DATABASE_URL is available.
  // This allows codegen commands (e.g. prisma generate) to run
  // without a live database connection.
  ...(databaseUrl ? { datasource: { url: databaseUrl } } : {}),
});
