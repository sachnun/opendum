import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const usePglite = !process.env.DATABASE_URL;

export default defineConfig({
  schema: "../../packages/shared/src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  ...(usePglite
    ? {
        driver: "pglite",
        dbCredentials: { url: ".pglite" },
      }
    : {
        dbCredentials: { url: process.env.DATABASE_URL! },
      }),
});
