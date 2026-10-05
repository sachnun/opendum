import js from "@eslint/js";
import tseslint from "typescript-eslint";

import noComments from "eslint-plugin-no-comments";

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
      "max-lines": "warn",
    },
  },
  {
    files: ["**/*.{ts,mts,cts,js,mjs,cjs}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: "ExportAllDeclaration:not([exported])" },
        { selector: "ImportDeclaration[source.value=/\\.js$/]" },
        { selector: "ImportExpression[source.value=/\\.js$/]" },
        { selector: "ExportNamedDeclaration[source.value=/\\.js$/], ExportAllDeclaration[source.value=/\\.js$/]" },
      ],
    },
  },
  {
    files: ["**/*.{ts,mts,cts,js,mjs,cjs}"],
    plugins: { "no-comments": noComments },
    rules: {
      "no-comments/disallowComments": ["error", { allow: ["eslint", "global", "/usr/bin/env"] }],
    },
  },
);
