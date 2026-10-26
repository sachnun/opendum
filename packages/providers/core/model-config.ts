import type { Registry } from "@opendum/models/runtime";
import type { ProviderModelConfig } from "@opendum/models/runtime";

export class ModelConfig {
  private readonly registry: Registry;

  private readonly model: string;

  private readonly provider: string;

  constructor(registry: Registry, model: string, provider: string) {
    this.registry = registry;
    this.model = model;
    this.provider = provider;
  }

  private value(key: string): unknown {
    const cfg = this.registry.config(this.model, this.provider);
    if (!cfg) return undefined;
    if (key in cfg) return cfg[key];
    const custom = cfg.custom;
    if (custom && typeof custom === "object" && key in custom) return custom[key];
    return undefined;
  }

  all(): ProviderModelConfig | null {
    return this.registry.config(this.model, this.provider);
  }

  bool(key: string): boolean {
    return this.value(key) === true;
  }

  string(key: string): string {
    const value = this.value(key);
    return typeof value === "string" ? value.trim() : "";
  }

  maxOutputTokens(): number {
    return this.all()?.maxOutputTokens ?? 0;
  }
}
