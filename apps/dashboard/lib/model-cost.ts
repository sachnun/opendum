export interface ModelCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export const MODEL_COST_FIELDS: Array<{ key: keyof ModelCost; label: string }> = [
  { key: "input", label: "Input" },
  { key: "output", label: "Output" },
  { key: "cacheRead", label: "Cache read" },
  { key: "cacheWrite", label: "Cache write" },
];

export function costEntries(cost: ModelCost): Array<{ label: string; value: number }> {
  return MODEL_COST_FIELDS.flatMap(({ key, label }) => {
    const value = cost[key];
    return typeof value === "number" ? [{ label, value }] : [];
  });
}

export function formatCostPoints(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 3 });
}
