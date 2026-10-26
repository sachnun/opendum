import { SUPPORTED_HARBOR, SUPPORTED_HYPER, SUPPORTED_KILO, SUPPORTED_NVIDIA, SUPPORTED_OPENROUTER, SUPPORTED_ZENMUX } from "@opendum/providers/upstreams/compat/index";
import type { CompatSpec } from "@opendum/providers/core/spec";
import { COMPAT_ENTRIES } from "@opendum/providers/registry-specs";

export type { CompatSpec } from "@opendum/providers/core/spec";

const PARAMS: Record<string, Set<string>> = {
  openrouter: SUPPORTED_OPENROUTER,
  nvidia_nim: SUPPORTED_NVIDIA,
  kilo_code: SUPPORTED_KILO,
  harbor: SUPPORTED_HARBOR,
  zenmux: SUPPORTED_ZENMUX,
  hyper: SUPPORTED_HYPER,
};

export type CompatRoute = CompatSpec & { readonly supportedParams: Set<string> };

export const COMPAT_SPECS: ReadonlyArray<CompatRoute> = COMPAT_ENTRIES.flatMap((entry) => {
  const compat = entry.compat;
  if (!compat) return [];
  const supportedParams = PARAMS[compat.name];
  if (!supportedParams) return [];
  return [{ ...compat, supportedParams }];
});
