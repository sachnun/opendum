import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "../shared/src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
