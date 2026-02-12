"use client";

import { useState, useMemo, useCallback } from "react";
import { ModelCard } from "./model-card";
import { toast } from "sonner";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import { setModelEnabled } from "@/lib/actions/models";
import type { ModelMeta } from "@/lib/proxy/models";

interface ModelWithStats {
  id: string;
  providers: string[];
  providerLabels: string[];
  meta?: ModelMeta;
  isEnabled: boolean;
  stats: {
    totalRequests: number;
    successRate: number | null;
    dailyRequests: Array<{ date: string; count: number }>;
    avgDurationLastDay: number | null;
    durationLast24Hours: Array<{ time: string; avgDuration: number | null }>;
  };
}

interface ModelsListProps {
  models: ModelWithStats[];
  availableProviders: { id: string; label: string }[];
}

const FEATURED_FAMILIES = [
  "OpenAI",
  "Claude",
  "Gemini",
  "Qwen",
  "DeepSeek",
  "Kimi",
  "MiniMax",
  "Z.AI",
] as const;

type FeaturedFamily = (typeof FEATURED_FAMILIES)[number];

const FAMILY_ANCHOR_IDS: Record<FeaturedFamily, string> = {
  OpenAI: "openai-models",
  Claude: "claude-models",
  Gemini: "gemini-models",
  Qwen: "qwen-models",
  DeepSeek: "deepseek-models",
  Kimi: "kimi-models",
  MiniMax: "minimax-models",
  "Z.AI": "zai-models",
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
  if (normalizedModelId.startsWith("qwen")) {
    return "Qwen";
  }
  if (normalizedModelId.startsWith("deepseek")) {
    return "DeepSeek";
  }
  if (normalizedModelId.startsWith("kimi-")) {
    return "Kimi";
  }
  if (normalizedModelId.startsWith("minimax-")) {
    return "MiniMax";
  }
  if (normalizedModelId.startsWith("glm-") || normalizedModelId.startsWith("z-ai")) {
    return "Z.AI";
  }

  return "Others";
}

export function ModelsList({ models, availableProviders }: ModelsListProps) {
  const allProviderIds = useMemo(
    () => availableProviders.map((p) => p.id),
    [availableProviders]
  );

  const [activeProviders, setActiveProviders] = useState<string[]>(allProviderIds);
  const [enabledByModel, setEnabledByModel] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(models.map((model) => [model.id, model.isEnabled]))
  );
  const [pendingByModel, setPendingByModel] = useState<Record<string, boolean>>({});

  const modelsWithState = useMemo(
    () =>
      models.map((model) => ({
        ...model,
        isEnabled: enabledByModel[model.id] ?? model.isEnabled,
      })),
    [enabledByModel, models]
  );

  const allSelected = activeProviders.length === availableProviders.length;

  const handleEnabledChange = useCallback(async (modelId: string, enabled: boolean) => {
    setEnabledByModel((prev) => ({ ...prev, [modelId]: enabled }));
    setPendingByModel((prev) => ({ ...prev, [modelId]: true }));

    try {
      const result = await setModelEnabled(modelId, enabled);

      if (!result.success) {
        throw new Error(result.error);
      }

      toast.success(enabled ? "Model enabled" : "Model disabled");
    } catch (error) {
      setEnabledByModel((prev) => ({ ...prev, [modelId]: !enabled }));
      toast.error(
        error instanceof Error ? error.message : "Failed to update model status"
      );
    } finally {
      setPendingByModel((prev) => {
        const next = { ...prev };
        delete next[modelId];
        return next;
      });
    }
  }, []);

  const handleValueChange = useCallback(
    (value: string[]) => {
      const hasAll = value.includes("all");
      const providers = value.filter((v) => v !== "all");

      // User just clicked "All" (wasn't selected before)
      if (hasAll && !allSelected) {
        setActiveProviders(allProviderIds);
        return;
      }

      // All was selected, user unchecked a provider — deselect "all", keep the rest
      if (!hasAll && allSelected) {
        // When all were selected and user deselects one, keep the rest
        if (providers.length > 0) {
          setActiveProviders(providers);
          return;
        }
        // Don't allow empty selection
        return;
      }

      // Normal toggle — don't allow empty selection
      if (providers.length === 0) return;

      // If all individual providers are now selected, treat as "all"
      if (providers.length === allProviderIds.length) {
        setActiveProviders(allProviderIds);
        return;
      }

      setActiveProviders(providers);
    },
    [allSelected, allProviderIds]
  );

  const filteredModels = useMemo(() => {
    const active = new Set(activeProviders);
    return modelsWithState.filter((model) =>
      model.providers.some((provider) => active.has(provider))
    );
  }, [modelsWithState, activeProviders]);

  const filteredEnabledCount = useMemo(
    () => filteredModels.filter((model) => model.isEnabled).length,
    [filteredModels]
  );

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
      <ToggleGroup
        type="multiple"
        variant="outline"
        size="sm"
        spacing={2}
        value={allSelected ? ["all", ...activeProviders] : activeProviders}
        onValueChange={handleValueChange}
        className="flex-wrap"
      >
        <ToggleGroupItem value="all" aria-label="Show all providers">
          All
        </ToggleGroupItem>
        {availableProviders.map((provider) => (
          <ToggleGroupItem
            key={provider.id}
            value={provider.id}
            aria-label={`Filter by ${provider.label}`}
          >
            {provider.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <p className="text-xs font-medium text-muted-foreground">
        {filteredModels.length} / {models.length} models - {filteredEnabledCount} enabled
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
                    stats={model.stats}
                    isEnabled={model.isEnabled}
                    isUpdating={Boolean(pendingByModel[model.id])}
                    onEnabledChange={handleEnabledChange}
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
