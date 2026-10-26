import { Effect } from "effect";
import type { DatabaseFailure } from "@opendum/database";
import type { Registry } from "@opendum/models/runtime";
import { invalid, valid } from "@opendum/auth/results";
import type { ModelRecord, CustomProviderReader } from "@opendum/auth/store/custom";
import type { ModelValidationResult } from "@opendum/auth/types";

export class CustomModels {
  constructor(
    private readonly registry: Registry,
    private readonly customProviders: CustomProviderReader
  ) {}

  list(userId: string): Effect.Effect<Array<Record<string, unknown>>, DatabaseFailure> {
    return Effect.gen({ self: this }, function* () {
      const { standalone } = yield* this.modelSets(userId);
      const now = Math.floor(Date.now() / 1000);
      const items: Array<Record<string, unknown>> = [];
      for (const [slug, models] of standalone) {
        for (const modelId of models) {
          items.push({
            id: `${slug}/${modelId}`,
            object: "model",
            created: now,
            owned_by: `custom:${slug}`,
          });
        }
      }
      return items;
    });
  }

  result(
    userId: string,
    slug: string,
    rawModel: string
  ): Effect.Effect<ModelValidationResult | null, DatabaseFailure> {
    return Effect.gen({ self: this }, function* () {
      const custom = yield* this.customProviders.getProvider(userId, slug);
      if (!custom) return null;
      const rows = yield* this.customProviders.listModels(custom.id);
      for (const row of rows) {
        if (row.modelId !== rawModel) continue;
        const result = valid(slug, `${slug}/${rawModel}`);
        if (row.aliased) {
          const canonical = this.registry.resolveAlias(row.modelId);
          if (this.registry.isSupported(canonical)) result.alias = canonical;
        }
        result.vision = vision(this.registry, row);
        return result;
      }
      return invalid(
        slug,
        rawModel,
        `Model "${rawModel}" is not registered under your custom provider "${slug}".`,
        "model",
        "invalid_model"
      );
    });
  }

  modelSets(
    userId: string
  ): Effect.Effect<{ aliased: Map<string, Set<string>>; standalone: Map<string, string[]> }, DatabaseFailure> {
    return Effect.gen({ self: this }, function* () {
      const aliased = new Map<string, Set<string>>();
      const standalone = new Map<string, string[]>();
      const providers = yield* this.customProviders.listProviders(userId);
      for (const custom of providers) {
        const rows = yield* this.customProviders.listModels(custom.id);
        for (const row of rows) {
          const canonical = this.registry.resolveAlias(row.modelId);
          if (row.aliased && this.registry.isSupported(canonical)) {
            const set = aliased.get(custom.slug) ?? new Set<string>();
            set.add(canonical);
            aliased.set(custom.slug, set);
            continue;
          }
          const list = standalone.get(custom.slug) ?? [];
          list.push(row.modelId);
          standalone.set(custom.slug, list);
        }
      }
      return { aliased, standalone };
    });
  }
}

function vision(
  registry: Registry,
  row: ModelRecord
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
