export type AccessMode = "all" | "whitelist" | "blacklist";

export function sameList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function normalizeIds(ids: string[], compare?: (left: string, right: string) => number): string[] {
  return Array.from(new Set(ids)).sort(compare);
}
