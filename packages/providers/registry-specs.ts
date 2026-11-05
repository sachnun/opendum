import type { ProviderEntry, ProviderSpec } from "@opendum/providers/spec";

import { PROVIDER as antigravity } from "@opendum/providers/auth/antigravity/constants";
import { PROVIDER as cline } from "@opendum/providers/auth/cline/constants";
import { PROVIDER as cloudflare } from "@opendum/providers/auth/cloudflare/constants";
import { PROVIDER as codex } from "@opendum/providers/auth/codex/constants";
import { PROVIDER as harbor } from "@opendum/providers/auth/harbor/constants";
import { PROVIDER as hyper } from "@opendum/providers/auth/hyper/constants";
import { PROVIDER as kiloCode } from "@opendum/providers/auth/kilo-code/constants";
import { PROVIDER as kiro } from "@opendum/providers/auth/kiro/constants";
import { PROVIDER as nvidia } from "@opendum/providers/auth/nvidia/constants";
import { PROVIDER as openrouter } from "@opendum/providers/auth/openrouter/constants";
import { PROVIDER as perch } from "@opendum/providers/auth/perch/constants";
import { PROVIDER as workbuddy } from "@opendum/providers/auth/workbuddy/constants";
import { PROVIDER as zenmux } from "@opendum/providers/auth/zenmux/constants";

export const PROVIDERS: ReadonlyArray<ProviderEntry> = [
  antigravity,
  cline,
  cloudflare,
  codex,
  harbor,
  hyper,
  kiloCode,
  kiro,
  nvidia,
  openrouter,
  perch,
  workbuddy,
  zenmux,
] as ReadonlyArray<ProviderEntry>;

export const SPECS: ReadonlyArray<ProviderSpec> = PROVIDERS.flatMap((entry) =>
  entry.spec ? [entry.spec] : []
);

export const COMPAT_ENTRIES = PROVIDERS.filter((entry) => entry.compat !== undefined);

export const BY_KEY: Record<string, ProviderSpec> = Object.fromEntries(
  SPECS.map((spec) => [spec.key, spec])
);

export const BY_SLUG: Record<string, ProviderSpec> = Object.fromEntries(
  SPECS.map((spec) => [spec.slug, spec])
);

export function specOf(provider: string): ProviderSpec | undefined {
  return BY_KEY[provider];
}

export function slugOf(provider: string): string {
  return BY_KEY[provider]?.slug ?? provider;
}

export function labelOf(provider: string): string {
  return BY_KEY[provider]?.label ?? provider;
}

export function accountPath(provider: string): string {
  return `/accounts/${slugOf(provider)}`;
}

export function providerOf(slug: string): string | null {
  return BY_SLUG[slug.trim().toLowerCase()]?.key ?? null;
}
