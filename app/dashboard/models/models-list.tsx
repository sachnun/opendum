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

export function ModelsList({ models, availableProviders }: ModelsListProps) {
  const [activeProviders, setActiveProviders] = useState<Set<string>>(
    new Set(availableProviders.map((p) => p.id))
  );

  const toggleProvider = (providerId: string) => {
    setActiveProviders((prev) => {
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

  return (
    <div className="space-y-4 md:space-y-6">
      {/* Filter Bar */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground mr-1">Filter:</span>
        <Button
          variant={allSelected ? "default" : "outline"}
          size="sm"
          onClick={selectAllProviders}
          className="h-8"
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
              "h-8",
              activeProviders.has(provider.id) && !allSelected && "bg-primary"
            )}
          >
            {provider.label}
          </Button>
        ))}
      </div>

      {/* Results Count */}
      <p className="text-sm text-muted-foreground">
        Showing {filteredModels.length} of {models.length} models
      </p>

      {/* Models Grid */}
      <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        {filteredModels.map((model) => (
          <ModelCard
            key={model.id}
            id={model.id}
            providers={model.providerLabels}
            meta={model.meta}
          />
        ))}
      </div>

      {filteredModels.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No models found for the selected providers.
        </div>
      )}
    </div>
  );
}
