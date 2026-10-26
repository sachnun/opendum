export const pick = <T>(value: T | undefined | null, fallback: T): T =>
  value !== undefined && value !== null ? value : fallback;

export const join = (separator: string, ...values: string[]): string =>
  values.filter((value) => value.trim() !== "").join(separator);
