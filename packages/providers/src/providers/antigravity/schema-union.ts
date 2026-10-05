import { cloneAnyMap } from "#providers/lib/helpers.ts";
import {
  anySlice,
  inferEnumType,
  mapSlice,
  normalizeSchemaType,
  type Json,
} from "#providers/providers/antigravity/config.ts";

export function flattenAntigravityClaudeUnion(schema: Json): Json {
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const options = mapSlice(schema[key]);
    if (options.length === 0) continue;
    const [mergedEnum, enumOk] = enumFromSchemaUnion(options);
    const base = cloneSchemaWithoutUnions(schema);
    if (enumOk) {
      base.enum = mergedEnum;
      if (base.type === undefined) base.type = inferEnumType(mergedEnum);
      return base;
    }
    const best = bestSchemaUnionOption(options);
    for (const [baseKey, baseValue] of Object.entries(base)) {
      if (best[baseKey] === undefined) best[baseKey] = baseValue;
    }
    return best;
  }
  return schema;
}

export function enumFromSchemaUnion(options: Json[]): [unknown[], boolean] {
  const values: unknown[] = [];
  for (const option of options) {
    if (normalizeSchemaType(option.type) === "null") continue;
    if (option.const !== undefined) {
      values.push(option.const);
      continue;
    }
    const enumValues = anySlice(option.enum);
    if (enumValues.length > 0) {
      values.push(...enumValues);
      continue;
    }
    return [[], false];
  }
  return [values, values.length > 0];
}

export function schemaUnionOptionScore(schema: Json): number {
  switch (normalizeSchemaType(schema.type)) {
    case "object": {
      const props = schema.properties;
      return props !== null && typeof props === "object" && !Array.isArray(props) && Object.keys(props as Json).length > 0
        ? 60
        : 50;
    }
    case "array":
      return schema.items !== undefined ? 45 : 40;
    case "string":
      return anySlice(schema.enum).length > 0 ? 35 : 30;
    case "number":
    case "integer":
      return 20;
    case "boolean":
      return 10;
    default:
      break;
  }
  if (schema.properties !== undefined) return 55;
  if (schema.items !== undefined) return 42;
  if (schema.const !== undefined || schema.enum !== undefined) return 32;
  return 1;
}

export function bestSchemaUnionOption(options: Json[]): Json {
  let best: Json = {};
  let bestScore = -1;
  for (const option of options) {
    if (normalizeSchemaType(option.type) === "null") continue;
    const score = schemaUnionOptionScore(option);
    if (score > bestScore) {
      bestScore = score;
      best = cloneAnyMap(option);
    }
  }
  if (bestScore === -1 && options.length > 0) best = cloneAnyMap(options[0]);
  return best;
}

export function cloneSchemaWithoutUnions(schema: Json): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "anyOf" || key === "oneOf" || key === "allOf") continue;
    out[key] = value;
  }
  return out;
}
