import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: {
      "~": new URL("./src", import.meta.url).pathname,
    },
    conditions: ["development", "browser"],
  },
  test: {
    environment: "happy-dom",
    include: ["tests/components/**/*.spec.tsx"],
    setupFiles: ["./tests/components/setup.ts"],
  },
});
