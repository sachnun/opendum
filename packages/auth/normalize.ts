import type { Registry } from "@opendum/models/runtime";
import { compareText } from "@opendum/models/compare";

export function parseModel(modelParam: string): [string | null, string] {
  const index = modelParam.indexOf("/");
  if (index < 0) return [null, modelParam];
  return [providerAlias(modelParam.slice(0, index)), modelParam.slice(index + 1)];
}

export function accessMode(mode: string): string {
  return mode === "whitelist" || mode === "blacklist" ? mode : "all";
}

export function accountList(values: string[]): string[] {
  const trimmed = values.map((value) => value.trim());
  return uniqueSorted(trimmed.filter((value) => value.length > 0));
}

export function modelList(registry: Registry, values: string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const model = registry.resolveAlias(trimmed);
    if (registry.isSupported(model)) result.push(model);
  }
  return uniqueSorted(result);
}

export function accessList(registry: Registry, values: string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    let trimmed = value.trim();
    if (!trimmed) continue;
    if (registry.isSupported(trimmed)) trimmed = registry.resolveAlias(trimmed);
    result.push(trimmed);
  }
  return uniqueSorted(result);
}

export function disabledList(registry: Registry, values: string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const model = registry.resolveAlias(trimmed);
    result.push(registry.isSupported(model) ? model : trimmed);
  }
  return uniqueSorted(result);
}

export function listed(modelSet: Set<string>, model: string, provider: string | null): boolean {
  if (modelSet.has(model)) return true;
  return provider !== null && modelSet.has(`${provider}/${model}`);
}

function providerAlias(provider: string): string {
  return provider.trim().toLowerCase();
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort((a, b) => compareText(a, b));
}
