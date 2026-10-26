import { CASE_FORMATS, matchesFormat, splitIdentifier, stripUnderscores } from "../lib/identifiers.mjs";
import { identifierVisitor } from "../lib/visitors.mjs";

const SELECTOR_SCHEMA = {
  type: "object",
  properties: {
    selector: { enum: ["default", "variable", "function", "parameter", "type", "member"] },
    format: { type: ["array", "null"], items: { enum: CASE_FORMATS } },
    leadingUnderscore: { enum: ["allow", "allowDouble", "forbid"] },
    trailingUnderscore: { enum: ["allow", "allowDouble", "forbid"] },
    maxSegments: { type: "integer", minimum: 1 },
    forbid: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
};

const SCHEMA = { type: "array", items: SELECTOR_SCHEMA };

const DEFAULTS = {
  format: ["camelCase"],
  leadingUnderscore: "allow",
  trailingUnderscore: "forbid",
  maxSegments: null,
  forbid: [],
};

const KIND_TO_SELECTOR = {
  variable: "variable",
  function: "function",
  parameter: "parameter",
  type: "type",
  member: "member",
};

function resolveConfig(options) {
  const resolved = { ...DEFAULTS };
  for (const option of options) {
    if (!option || option.selector === "default") Object.assign(resolved, option ?? {});
  }
  for (const option of options) {
    if (option?.selector && option.selector !== "default") {
      resolved[option.selector] = { ...DEFAULTS, ...option };
    }
  }
  return resolved;
}

export const namingConvention = {
  meta: {
    type: "suggestion",
    docs: { description: "Enforce identifier naming conventions across declarations" },
    schema: SCHEMA,
    messages: {
      format: "{{kind}} `{{name}}` must match one of: {{formats}}.",
      underscore: "{{kind}} `{{name}}` must not have {{position}} underscores.",
      segments: "{{kind}} `{{name}}` is too specific: {{count}} words (max {{max}}).",
      forbidden: "{{kind}} `{{name}}` contains a forbidden word: `{{word}}`.",
    },
  },
  create(context) {
    const config = resolveConfig(context.options ?? []);
    const report = (node, kind, messageId, data) =>
      context.report({ node, messageId, data: { kind, name: node.name, ...data } });

    const handle = (node, kind) => {
      const rule = config[KIND_TO_SELECTOR[kind]] ?? config;
      const { core, problem } = stripUnderscores(
        node.name,
        rule.leadingUnderscore ?? DEFAULTS.leadingUnderscore,
        rule.trailingUnderscore ?? DEFAULTS.trailingUnderscore
      );

      if (problem) report(node, kind, "underscore", { position: problem });

      if (!core) return;

      if (rule.format && !matchesFormat(core, rule.format)) {
        report(node, kind, "format", { formats: rule.format.join(", ") });
      }

      if (rule.maxSegments) {
        const segments = splitIdentifier(core).length;
        if (segments > rule.maxSegments) {
          report(node, kind, "segments", { count: segments, max: rule.maxSegments });
        }
      }

      if (rule.forbid?.length) {
        const lower = node.name.toLowerCase();
        const word = rule.forbid.find((entry) => lower.includes(entry.toLowerCase()));
        if (word) report(node, kind, "forbidden", { word });
      }
    };

    return identifierVisitor(handle);
  },
};
