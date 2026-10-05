import noComments from "eslint-plugin-no-comments";
import withNuxt from "./.nuxt/eslint.config.mjs";

export default withNuxt({
  plugins: { "no-comments": noComments },
  rules: {
    "no-comments/disallowComments": ["error", { allow: ["eslint", "global", "/usr/bin/env"] }],
    "no-empty": ["error", { allowEmptyCatch: true }],
  },
});
