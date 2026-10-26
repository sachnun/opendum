import { namingConvention } from "./rules/naming-convention.mjs";

export default {
  meta: { name: "naming" },
  rules: {
    "naming-convention": namingConvention,
  },
};
