"use client";

import { useMemo, useState } from "react";
import { Check, ChevronDown, ListFilter, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";
import { updateApiKeyModelAccess, type ApiKeyModelAccessMode } from "@/lib/actions/api-keys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

interface ApiKeyModelAccessProps {
  apiKeyId: string;
  availableModels: string[];
  initialMode: ApiKeyModelAccessMode;
  initialModels: string[];
}

function normalizeModels(models: string[]): string[] {
  return Array.from(new Set(models)).sort((a, b) => a.localeCompare(b));
}

function sameModelList(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((model, index) => model === right[index]);
}

function getModeLabel(mode: ApiKeyModelAccessMode): string {
  if (mode === "all") {
    return "All models";
  }

  if (mode === "whitelist") {
    return "Whitelist";
  }

  return "Blacklist";
}

export function ApiKeyModelAccess({
  apiKeyId,
  availableModels,
  initialMode,
  initialModels,
}: ApiKeyModelAccessProps) {
  const normalizedInitialModels = useMemo(() => normalizeModels(initialModels), [initialModels]);

  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const [savedMode, setSavedMode] = useState<ApiKeyModelAccessMode>(initialMode);
  const [savedModels, setSavedModels] = useState<string[]>(normalizedInitialModels);

  const [draftMode, setDraftMode] = useState<ApiKeyModelAccessMode>(initialMode);
  const [draftModels, setDraftModels] = useState<string[]>(normalizedInitialModels);

  const normalizedDraftModels = useMemo(() => normalizeModels(draftModels), [draftModels]);
  const normalizedSavedModels = useMemo(() => normalizeModels(savedModels), [savedModels]);

  const modelsForSave = draftMode === "all" ? [] : normalizedDraftModels;
  const hasChanges =
    draftMode !== savedMode ||
    !sameModelList(modelsForSave, draftMode === "all" ? [] : normalizedSavedModels);

  const resetDraftState = () => {
    setDraftMode(savedMode);
    setDraftModels(normalizedSavedModels);
    setModelPickerOpen(false);
  };

  const toggleModel = (modelId: string) => {
    setDraftModels((current) => {
      if (current.includes(modelId)) {
        return current.filter((model) => model !== modelId);
      }
      return [...current, modelId];
    });
  };

  const handleSave = async () => {
    if (draftMode !== "all" && modelsForSave.length === 0) {
      toast.error("Select at least one model");
      return;
    }

    setIsSaving(true);
    try {
      const result = await updateApiKeyModelAccess(apiKeyId, draftMode, modelsForSave);
      if (!result.success) {
        throw new Error(result.error);
      }

      const nextModels = normalizeModels(result.data.models);
      setSavedMode(result.data.mode);
      setSavedModels(nextModels);
      setDraftMode(result.data.mode);
      setDraftModels(nextModels);
      setModelPickerOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update model access");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="flex h-full flex-col rounded-xl border border-border/70 bg-muted/20 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="inline-flex items-center gap-2 text-sm font-semibold">
            <ListFilter className="h-4 w-4 text-muted-foreground" />
            <span>Model Access</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Choose whether this key can use all models, only selected models, or all except selected models.
          </p>
        </div>
        <Badge variant="outline" className="shrink-0">
          {getModeLabel(savedMode)}
        </Badge>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg border border-border/60 bg-background/80 px-3 py-2">
          <p className="text-[11px] text-muted-foreground">Mode</p>
          <p className="mt-1 font-medium">{getModeLabel(savedMode)}</p>
        </div>
        <div className="rounded-lg border border-border/60 bg-background/80 px-3 py-2">
          <p className="text-[11px] text-muted-foreground">Selected</p>
          <p className="mt-1 font-medium">
            {savedMode === "all" ? "All models" : `${normalizedSavedModels.length} model`}
            {savedMode !== "all" && normalizedSavedModels.length !== 1 ? "s" : ""}
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-3 flex-1">
        <div className="space-y-1.5">
          <p className="text-xs font-medium">Mode</p>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={draftMode}
            onValueChange={(value) => {
              if (value === "all" || value === "whitelist" || value === "blacklist") {
                setDraftMode(value);
              }
            }}
            className="w-full justify-start"
          >
            <ToggleGroupItem value="all" className="flex-1">All</ToggleGroupItem>
            <ToggleGroupItem value="whitelist" className="flex-1">Whitelist</ToggleGroupItem>
            <ToggleGroupItem value="blacklist" className="flex-1">Blacklist</ToggleGroupItem>
          </ToggleGroup>
        </div>

        {draftMode !== "all" && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium">Models</p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => setDraftModels([])}
                disabled={normalizedDraftModels.length === 0 || isSaving}
              >
                Clear
              </Button>
            </div>

            <Popover open={modelPickerOpen} onOpenChange={setModelPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className="h-9 w-full justify-between px-3 text-xs"
                  disabled={isSaving}
                >
                  <span className="truncate">
                    {normalizedDraftModels.length > 0
                      ? `${normalizedDraftModels.length} model selected`
                      : "Select models"}
                  </span>
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-[min(90vw,28rem)] p-0">
                <Command>
                  <CommandInput placeholder="Search model..." />
                  <CommandList>
                    <CommandEmpty>No model found.</CommandEmpty>
                    <CommandGroup>
                      {availableModels.map((modelId) => {
                        const selected = normalizedDraftModels.includes(modelId);
                        return (
                          <CommandItem
                            key={modelId}
                            value={modelId}
                            onSelect={() => toggleModel(modelId)}
                            className="gap-2"
                          >
                            <Check
                              className={cn(
                                "h-3.5 w-3.5",
                                selected ? "opacity-100" : "opacity-0"
                              )}
                            />
                            <span className="truncate font-mono text-[11px]">{modelId}</span>
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>

            <div className="max-h-40 overflow-y-auto rounded-lg border border-border/60 bg-background/80 p-2">
              {normalizedDraftModels.length === 0 ? (
                <p className="px-1 text-[11px] text-muted-foreground">No models selected</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {normalizedDraftModels.map((modelId) => (
                    <Badge
                      key={modelId}
                      variant="secondary"
                      className="max-w-full gap-1 pr-1 font-normal text-[10px]"
                    >
                      <span className="min-w-0 truncate font-mono">{modelId}</span>
                      <button
                        type="button"
                        className="inline-flex h-4 w-4 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                        onClick={() => toggleModel(modelId)}
                        aria-label={`Remove ${modelId}`}
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center justify-end gap-2 border-t border-border/60 pt-3">
        <Button
          variant="outline"
          size="sm"
          onClick={resetDraftState}
          disabled={isSaving || !hasChanges}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Reset
        </Button>
        <Button size="sm" onClick={handleSave} disabled={isSaving || !hasChanges}>
          {isSaving ? "Saving..." : "Save"}
        </Button>
      </div>
    </section>
  );
}
