import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.output/**",
      "**/.nuxt/**",
      "**/.edgeone/**",
      "**/.nitro/**",
      "**/dist/**",
      "**/coverage/**",
      "**/drizzle/**",
      "**/*.d.ts",
    ],
  },
  {
    files: ["**/*.{ts,mts,cts,js,mjs,cjs}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-namespace": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "prefer-const": "warn",
      "no-useless-assignment": "warn",
      "preserve-caught-error": "warn",
      "max-lines": ["warn", { max: 500, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ["**/*.{ts,mts,cts,js,mjs,cjs}"],
    ignores: ["**/index.ts"],
    rules: {
      "no-restricted-syntax": [
        "warn",
        { selector: "ExportAllDeclaration", message: "Prefer explicit named re-exports outside package barrels." },
      ],
    },
  },
);
