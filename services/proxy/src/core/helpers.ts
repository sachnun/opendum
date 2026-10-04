export function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function defaultStringValue(value: unknown, fallback: string): string {
  const str = stringValue(value);
  return str !== "" ? str : fallback;
}

export function numberAsInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return 0;
}

export function numberAsFloat(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function cloneMap(input: Record<string, unknown>): Record<string, unknown> {
  return { ...input };
}

export function cloneMapExcept(
  input: Record<string, unknown>,
  ...excluded: string[]
): Record<string, unknown> {
  const exclude = new Set(excluded);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!exclude.has(key)) out[key] = value;
  }
  return out;
}

export function anySlice(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function mapSlice(value: unknown): Record<string, unknown>[] {
  return anySlice(value).filter(
    (item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item)
  );
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    });
  });
}
