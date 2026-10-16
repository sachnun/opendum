import { randomUuid, stringValue } from "../../core/helpers.js";

export type Json = Record<string, unknown>;

export const RETIRED_MODEL_PATTERN = /\bis no longer available\.?\s*Please switch to\b/i;

export function defaultAny(value: unknown, fallback: unknown): unknown {
  return value !== undefined && value !== null ? value : fallback;
}

export function anySlice(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function mapSlice(value: unknown): Json[] {
  return anySlice(value).filter(
    (item): item is Json => item !== null && typeof item === "object" && !Array.isArray(item)
  );
}

export { randomUuid };

export function randomHyphenId(prefix: string): string {
  return `${prefix}-${randomUuid()}`;
}

export function normalizeSchemaType(value: unknown): string {
  const text = stringValue(value);
  if (text) return text;
  for (const raw of anySlice(value)) {
    const item = stringValue(raw);
    if (item && item !== "null") return item;
  }
  const values = anySlice(value);
  return values.length > 0 ? stringValue(values[0]) : "";
}

export function sanitizedToolName(name: string): string {
  if (name && name[0] >= "0" && name[0] <= "9") return `t_${name}`;
  return name;
}

export function inferEnumType(values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string") return "string";
    if (typeof value === "boolean") return "boolean";
    if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  }
  return "string";
}
