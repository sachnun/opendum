// Prisma config for Opendum
import "dotenv/config";
import { defineConfig } from "prisma/config";

// Use DATABASE_URL from environment (falls back to .env.local via Next.js)
const databaseUrl = process.env.DATABASE_URL || "postgresql://daku@localhost:5432/opendum";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: databaseUrl,
  },
});
