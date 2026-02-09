"use client";

import { useState, useMemo } from "react";
import { ModelCard } from "./model-card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ModelMeta } from "@/lib/proxy/models";

interface ModelWithStats {
  id: string;
  providers: string[];
  providerLabels: string[];
  meta?: ModelMeta;
}

interface ModelsListProps {
  models: ModelWithStats[];
  availableProviders: { id: string; label: string }[];
}

const FEATURED_FAMILIES = ["OpenAI", "Claude", "Gemini"] as const;

type FeaturedFamily = (typeof FEATURED_FAMILIES)[number];

const FAMILY_ANCHOR_IDS: Record<FeaturedFamily, string> = {
  OpenAI: "openai-models",
  Claude: "claude-models",
  Gemini: "gemini-models",
};

interface ModelSection {
  name: string;
  anchorId: string;
  models: ModelWithStats[];
}

function getModelFamily(modelId: string): FeaturedFamily | "Others" {
  const normalizedModelId = modelId.toLowerCase();

  if (normalizedModelId.startsWith("gpt-")) {
    return "OpenAI";
  }
  if (normalizedModelId.startsWith("claude-")) {
    return "Claude";
  }
  if (normalizedModelId.startsWith("gemini-")) {
    return "Gemini";
  }

  return "Others";
}

export function ModelsList({ models, availableProviders }: ModelsListProps) {
  const [activeProviders, setActiveProviders] = useState<Set<string>>(
    new Set(availableProviders.map((p) => p.id))
  );

  const toggleProvider = (providerId: string) => {
    setActiveProviders((prev) => {
      // Jika semua provider sedang terpilih (All aktif), klik satu provider = hanya pilih provider itu
      if (prev.size === availableProviders.length) {
        return new Set([providerId]);
      }

      const next = new Set(prev);
      if (next.has(providerId)) {
        // Don't allow deselecting all providers
        if (next.size > 1) {
          next.delete(providerId);
        }
      } else {
        next.add(providerId);
      }
      return next;
    });
  };

  const selectAllProviders = () => {
    setActiveProviders(new Set(availableProviders.map((p) => p.id)));
  };

  const filteredModels = useMemo(() => {
    return models.filter((model) =>
      model.providers.some((provider) => activeProviders.has(provider))
    );
  }, [models, activeProviders]);

  const allSelected = activeProviders.size === availableProviders.length;

  const modelSections = useMemo(() => {
    const groupedModels = new Map<string, ModelWithStats[]>();

    for (const model of filteredModels) {
      const family = getModelFamily(model.id);
      const familyModels = groupedModels.get(family) ?? [];
      familyModels.push(model);
      groupedModels.set(family, familyModels);
    }

    for (const familyModels of groupedModels.values()) {
      familyModels.sort((a, b) => a.id.localeCompare(b.id));
    }

    const sections: ModelSection[] = [];

    for (const family of FEATURED_FAMILIES) {
      const familyModels = groupedModels.get(family);
      if (!familyModels?.length) {
        continue;
      }

      sections.push({
        name: family,
        anchorId: FAMILY_ANCHOR_IDS[family],
        models: familyModels,
      });
    }

    const others = groupedModels.get("Others");
    if (others?.length) {
      sections.push({
        name: "Others",
        anchorId: "other-models",
        models: others,
      });
    }

    return sections;
  }, [filteredModels]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted p-1.5">
        <Button
          variant={allSelected ? "default" : "outline"}
          size="sm"
          onClick={selectAllProviders}
          className="h-8 rounded-lg"
        >
          All
        </Button>
        {availableProviders.map((provider) => (
          <Button
            key={provider.id}
            variant={activeProviders.has(provider.id) ? "default" : "outline"}
            size="sm"
            onClick={() => toggleProvider(provider.id)}
            className={cn(
              "h-8 rounded-lg",
              activeProviders.has(provider.id) && !allSelected && "bg-primary"
            )}
          >
            {provider.label}
          </Button>
        ))}
      </div>

      <p className="text-xs font-medium text-muted-foreground">
        {filteredModels.length} / {models.length} models
      </p>

      {modelSections.length > 0 && (
        <div className="space-y-8">
          {modelSections.map((section) => (
            <section key={section.name} id={section.anchorId} className="scroll-mt-24 space-y-3">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold">{section.name}</h3>
                <span className="text-xs text-muted-foreground">{section.models.length} models</span>
              </div>
              <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                {section.models.map((model) => (
                  <ModelCard
                    key={model.id}
                    id={model.id}
                    providers={model.providerLabels}
                    meta={model.meta}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {filteredModels.length === 0 && (
        <div className="rounded-lg border border-dashed border-border py-12 text-center text-muted-foreground">
          No models found for the selected providers.
        </div>
      )}
    </div>
  );
}
