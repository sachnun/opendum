export function compactStrings(values: string[] | undefined): string[] {
  if (!values) return [];
  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

export function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort((a, b) => a.localeCompare(b));
}

export function uniqueSortedStable(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}
