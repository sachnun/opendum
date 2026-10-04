import type { Registry } from "@opendum/models/runtime";
import type { CustomProviderModelRecord } from "#auth/custom-store.ts";
import type { ModelValidationResult } from "#auth/types.ts";

export const AUTHLESS_PROVIDER_NAMES = ["opencode"];

export function isAuthlessProvider(provider: string): boolean {
  return AUTHLESS_PROVIDER_NAMES.includes(provider);
}

export function parseModelParam(modelParam: string): [string | null, string] {
  const index = modelParam.indexOf("/");
  if (index < 0) return [null, modelParam];
  return [normalizeProviderAlias(modelParam.slice(0, index)), modelParam.slice(index + 1)];
}

export function isAuthlessProviderAccountId(accountId: string): boolean {
  return AUTHLESS_PROVIDER_NAMES.includes(accountId) || accountId.startsWith("authless:");
}

function normalizeProviderAlias(provider: string): string {
  return provider.trim().toLowerCase();
}

export function normalizeAccessMode(mode: string): string {
  return mode === "whitelist" || mode === "blacklist" ? mode : "all";
}

export function normalizeAccountList(values: string[]): string[] {
  return uniqueSorted(values.map((value) => value.trim()).filter((value) => value.length > 0));
}

export function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort((a, b) => a.localeCompare(b));
}

export function normalizeDisabledModelList(registry: Registry, values: string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const model = registry.resolveAlias(trimmed);
    result.push(registry.isSupported(model) ? model : trimmed);
  }
  return uniqueSorted(result);
}

export function bearerToken(authHeader: string): string {
  const trimmed = authHeader.trim();
  if (trimmed.length >= 7 && trimmed.slice(0, 7).toLowerCase() === "bearer ") {
    return trimmed.slice(7).trim();
  }
  return trimmed;
}

export function defaultString(value: string, fallback: string): string {
  return value || fallback;
}

function normalizeTierAlias(tier: string): string {
  const normalized = tier.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "pro-plus" || normalized === "proplus") return "pro+";
  if (normalized === "free-tier") return "free";
  if (
    normalized === "education" ||
    normalized === "educational" ||
    normalized === "edu" ||
    normalized === "free-educational-quota"
  ) {
    return "student";
  }
  return normalized;
}

export function tierSatisfiesRule(
  accountTier: string,
  minTier: string | undefined,
  allowedTiers: string[] | undefined
): boolean {
  const normalizedAccountTier = normalizeTierAlias(accountTier);
  if (allowedTiers && allowedTiers.length > 0) {
    return allowedTiers.some((tier) => normalizeTierAlias(tier) === normalizedAccountTier);
  }
  const required = (minTier ?? "").trim().toLowerCase();
  if (!required || required === "free") return true;
  return normalizedAccountTier === normalizeTierAlias(required);
}

export function accessRuleRestrictsTier(
  minTier: string | undefined,
  allowedTiers: string[] | undefined
): boolean {
  if (allowedTiers && allowedTiers.length > 0) return true;
  const required = normalizeTierAlias(minTier ?? "");
  return required !== "" && required !== "free";
}

export function visionForCustomModel(
  registry: Registry,
  row: CustomProviderModelRecord
): boolean {
  const candidates = [row.upstream, row.modelId].filter(
    (value): value is string => Boolean(value && value.length > 0)
  );
  for (const candidate of candidates) {
    const info = registry.modelInfo(candidate);
    if (!info || info.modalities == null) continue;
    return (info.modalities.input ?? []).includes("image");
  }
  return true;
}

export function valid(provider: string | null, model: string): ModelValidationResult {
  return {
    valid: true,
    provider,
    model,
    alias: "",
    vision: null,
    error: "",
    param: "",
    code: "",
  };
}

export function invalid(
  provider: string | null,
  model: string,
  error: string,
  param: string,
  code: string
): ModelValidationResult {
  return {
    valid: false,
    provider,
    model,
    alias: "",
    vision: null,
    error,
    param,
    code,
  };
}

export function disabled(provider: string | null, model: string): ModelValidationResult {
  return invalid(
    provider,
    model,
    `Model "${model}" is disabled. Enable it from Web > Models first.`,
    "model",
    "model_disabled"
  );
}
