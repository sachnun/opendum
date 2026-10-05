import { defineVitestProject } from "@nuxt/test-utils/config";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.{test,spec}.ts"],
          environment: "node",
          passWithNoTests: true,
        },
      },
      await defineVitestProject({
        test: {
          name: "nuxt",
          include: ["test/nuxt/**/*.spec.ts"],
          environment: "nuxt",
          setupFiles: ["./test/setup.ts"],
        },
      }),
    ],
  },
});
