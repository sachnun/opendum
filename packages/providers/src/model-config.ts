import type { Registry } from "@opendum/models/runtime";
import type { ProviderModelConfig } from "@opendum/models/runtime";

function configValue(
  registry: Registry,
  model: string,
  provider: string,
  key: string
): unknown {
  const cfg = registry.providerModelConfig(model, provider);
  if (!cfg) return undefined;
  if (key in cfg) return cfg[key];
  const custom = cfg.custom;
  if (custom && typeof custom === "object" && key in custom) return custom[key];
  return undefined;
}

export function providerConfigBool(
  registry: Registry,
  model: string,
  provider: string,
  key: string
): boolean {
  return configValue(registry, model, provider, key) === true;
}

export function providerConfigString(
  registry: Registry,
  model: string,
  provider: string,
  key: string
): string {
  const value = configValue(registry, model, provider, key);
  return typeof value === "string" ? value.trim() : "";
}

export function providerConfig(registry: Registry, model: string, provider: string): ProviderModelConfig | null {
  return registry.providerModelConfig(model, provider);
}

export function providerMaxOutputTokens(
  registry: Registry,
  model: string,
  provider: string
): number {
  const cfg = registry.providerModelConfig(model, provider);
  return cfg?.maxOutputTokens ?? 0;
}
