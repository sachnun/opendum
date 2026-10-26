import { Ids, Value } from "../../core/helpers.js";

export type Json = Record<string, unknown>;

export const RETIRED_MODEL_PATTERN = /\bis no longer available\.?\s*Please switch to\b/i;

export const defaultAny = (value: unknown, fallback: unknown): unknown =>
  value !== undefined && value !== null ? value : fallback;

export const anySlice = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const mapSlice = (value: unknown): Json[] =>
  anySlice(value).filter(
    (item): item is Json => item !== null && typeof item === "object" && !Array.isArray(item)
  );

export class ToolNames {
  static hyphenId(prefix: string): string {
    return `${prefix}-${Ids.uuid()}`;
  }

  static schemaType(value: unknown): string {
    const text = Value.string(value);
    if (text) return text;
    for (const raw of anySlice(value)) {
      const item = Value.string(raw);
      if (item && item !== "null") return item;
    }
    const values = anySlice(value);
    return values.length > 0 ? Value.string(values[0]) : "";
  }

  static sanitize(name: string): string {
    if (name && name[0] >= "0" && name[0] <= "9") return `t_${name}`;
    return name;
  }

  static enumType(values: unknown[]): string {
    for (const value of values) {
      if (typeof value === "string") return "string";
      if (typeof value === "boolean") return "boolean";
      if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
    }
    return "string";
  }
}
