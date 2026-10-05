import { defaultEmpty, defaultStringValue, stringValue } from "#providers/lib/helpers.ts";
import {
  anySlice,
  defaultAny,
  inferEnumType,
  type Json,
  mapSlice,
  normalizeSchemaType,
  sanitizedToolName,
} from "#providers/providers/antigravity/config.ts";
import { flattenAntigravityClaudeUnion } from "#providers/providers/antigravity/schema-union.ts";

export {
  bestSchemaUnionOption,
  cloneSchemaWithoutUnions,
  enumFromSchemaUnion,
  flattenAntigravityClaudeUnion,
  schemaUnionOptionScore,
} from "#providers/providers/antigravity/schema-union.ts";

export function geminiTools(raw: unknown): unknown[] {
  const out: unknown[] = [];
  for (const item of anySlice(raw)) {
    const tool = (item ?? {}) as Json;
    const fn = (tool.function ?? {}) as Json;
    const name = stringValue(fn.name);
    if (!name) continue;
    const paramsValue = fn.parameters;
    const params =
      paramsValue !== null && typeof paramsValue === "object" && !Array.isArray(paramsValue)
        ? (paramsValue as Json)
        : { type: "object", properties: {} };
    out.push({
      name,
      description: defaultStringValue(fn.description, ""),
      parameters: sanitizeGoogleFunctionSchema(params),
    });
  }
  return out;
}

export function sanitizeGoogleFunctionSchema(schema: Json | null | undefined): Json {
  if (!schema || typeof schema !== "object") return {};
  const out: Json = {};
  for (const [key, value] of Object.entries(schema)) {
    switch (key) {
      case "type": {
        const typ = normalizeSchemaType(value);
        if (typ) out.type = typ;
        break;
      }
      case "properties": {
        const props =
          value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
        if (Object.keys(props).length === 0) continue;
        const cleaned: Json = {};
        for (const [name, rawProp] of Object.entries(props)) {
          if (rawProp !== null && typeof rawProp === "object" && !Array.isArray(rawProp)) {
            cleaned[name] = sanitizeGoogleFunctionSchema(rawProp as Json);
          }
        }
        if (Object.keys(cleaned).length > 0) out.properties = cleaned;
        break;
      }
      case "items":
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          out.items = sanitizeGoogleFunctionSchema(value as Json);
        }
        break;
      case "anyOf": {
        const items: unknown[] = [];
        for (const rawItem of anySlice(value)) {
          if (rawItem !== null && typeof rawItem === "object" && !Array.isArray(rawItem)) {
            items.push(sanitizeGoogleFunctionSchema(rawItem as Json));
          }
        }
        if (items.length > 0) out.anyOf = items;
        break;
      }
      case "description":
      case "format":
      case "nullable":
      case "enum":
      case "required":
      case "propertyOrdering":
      case "minimum":
      case "maximum":
      case "minItems":
      case "maxItems":
      case "minLength":
      case "maxLength":
      case "pattern":
      case "title":
      case "default":
      case "example":
      case "minProperties":
      case "maxProperties":
        out[key] = value;
        break;
      default:
        break;
    }
  }
  if (schemaTypeAllowsNull(schema.type) && out.nullable === undefined) out.nullable = true;
  if (schema.const !== undefined && out.enum === undefined) out.enum = [schema.const];
  if (out.type === undefined) {
    if (out.properties !== undefined) out.type = "object";
    else if (out.items !== undefined) out.type = "array";
  }
  return out;
}

export function schemaTypeAllowsNull(value: unknown): boolean {
  return anySlice(value).some((raw) => stringValue(raw) === "null");
}

export function sanitizeAntigravityClaudeToolSchema(schema: Json | null | undefined): Json {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {}, required: [] };
  }
  const flattened = flattenAntigravityClaudeUnion(schema);
  const out: Json = {};
  for (const [key, value] of Object.entries(flattened)) {
    switch (key) {
      case "type": {
        const typ = normalizeSchemaType(value);
        if (typ) out.type = typ;
        break;
      }
      case "properties": {
        const props =
          value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
        const cleaned: Json = {};
        for (const [name, rawProp] of Object.entries(props)) {
          if (rawProp !== null && typeof rawProp === "object" && !Array.isArray(rawProp)) {
            cleaned[name] = sanitizeAntigravityClaudeToolSchema(rawProp as Json);
          }
        }
        out.properties = cleaned;
        break;
      }
      case "items":
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          out.items = sanitizeAntigravityClaudeToolSchema(value as Json);
        }
        break;
      case "description":
      case "enum":
        out[key] = value;
        break;
      default:
        break;
    }
  }
  if (flattened.const !== undefined && out.enum === undefined) out.enum = [flattened.const];
  if (out.type === undefined) out.type = inferAntigravityClaudeSchemaType(out);
  if (out.type === "object") {
    const props = (out.properties as Json | undefined) ?? {};
    out.properties = props;
    out.required = filteredSchemaRequired(flattened.required, props);
  }
  if (out.type === "array" && out.items === undefined) out.items = {};
  return out;
}

export function filteredSchemaRequired(raw: unknown, props: Json): unknown[] {
  const required: unknown[] = [];
  const seen = new Set<string>();
  for (const value of anySlice(raw)) {
    const name = stringValue(value);
    if (!name || props[name] === undefined || seen.has(name)) continue;
    seen.add(name);
    required.push(name);
  }
  return required;
}

export function inferAntigravityClaudeSchemaType(schema: Json): string {
  if (schema.properties !== undefined) return "object";
  if (schema.items !== undefined) return "array";
  const enumValues = anySlice(schema.enum);
  if (enumValues.length > 0) return inferEnumType(enumValues);
  return "object";
}

export type ToolSchemaMap = Record<string, Record<string, { typ: string }>>;

export function buildToolSchemaMap(raw: unknown): ToolSchemaMap {
  const result: ToolSchemaMap = {};
  for (const tool of mapSlice(raw)) {
    for (const decl of mapSlice(tool.functionDeclarations)) {
      const originalName = stringValue(decl.name);
      if (!originalName) continue;
      const schemaValue = defaultAny(decl.parametersJsonSchema, decl.parameters);
      const schema =
        schemaValue !== null && typeof schemaValue === "object" && !Array.isArray(schemaValue)
          ? (schemaValue as Json)
          : {};
      const props =
        schema.properties !== null && typeof schema.properties === "object" && !Array.isArray(schema.properties)
          ? (schema.properties as Json)
          : {};
      if (Object.keys(props).length === 0) continue;
      const paramMap: Record<string, { typ: string }> = {};
      for (const [paramName, rawParam] of Object.entries(props)) {
        const param = (rawParam ?? {}) as Json;
        paramMap[paramName] = { typ: defaultEmpty(normalizeSchemaType(param.type), "unknown") };
      }
      const sanitizedName = sanitizedToolName(originalName);
      result[sanitizedName] = paramMap;
      if (sanitizedName !== originalName) result[originalName] = paramMap;
    }
  }
  return result;
}

export function sanitizeToolSchemaKeys(schemas: ToolSchemaMap): void {
  for (const name of Object.keys(schemas)) {
    const sanitized = sanitizedToolName(name);
    if (sanitized !== name) schemas[sanitized] = schemas[name];
  }
}
