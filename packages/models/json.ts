export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function recordAt(value: unknown, key: string): JsonRecord | null {
  return asRecord(asRecord(value)?.[key]);
}

export function arrayAt(value: unknown, key: string): unknown[] {
  return asArray(asRecord(value)?.[key]);
}

export function stringAt(value: unknown, key: string): string | undefined {
  return asString(asRecord(value)?.[key]);
}

export function numberAt(value: unknown, key: string): number | undefined {
  return asNumber(asRecord(value)?.[key]);
}

export function booleanAt(value: unknown, key: string): boolean | undefined {
  return asBoolean(asRecord(value)?.[key]);
}

export function uniqueStrings(values: Iterable<unknown>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = asTrimmedString(value);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function sortedUniqueStrings(values: Iterable<unknown>): string[] {
  return uniqueStrings(values).sort((a, b) => a.localeCompare(b));
}

export function idsOf(value: unknown): string[] {
  return sortedUniqueStrings(asArray(value).map((item) => stringAt(item, "id")));
}
