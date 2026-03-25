"use client";

import { useMemo, useState } from "react";
import { Check, ChevronDown, ListFilter, X } from "lucide-react";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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

export function ApiKeyModelAccess({
  apiKeyId,
  availableModels,
  initialMode,
  initialModels,
}: ApiKeyModelAccessProps) {
  const normalizedInitialModels = useMemo(() => normalizeModels(initialModels), [initialModels]);

  const [open, setOpen] = useState(false);
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

  const modeLabel =
    savedMode === "all"
      ? "All models"
      : savedMode === "whitelist"
        ? "Whitelist"
        : "Blacklist";

  const resetDraftState = () => {
    setDraftMode(savedMode);
    setDraftModels(normalizedSavedModels);
    setModelPickerOpen(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      resetDraftState();
    }
    setOpen(nextOpen);
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
      setOpen(false);
      setModelPickerOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update model access");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground cursor-pointer"
        >
          <ListFilter className="h-3 w-3" />
          <span>{modeLabel}</span>
          {savedMode !== "all" && (
            <span className="text-muted-foreground/70">({normalizedSavedModels.length})</span>
          )}
        </button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Model Access Rules</DialogTitle>
          <DialogDescription className="sr-only">
            Control which models can be used with this API key.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
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
              <ToggleGroupItem value="all">All</ToggleGroupItem>
              <ToggleGroupItem value="whitelist">Whitelist</ToggleGroupItem>
              <ToggleGroupItem value="blacklist">Blacklist</ToggleGroupItem>
            </ToggleGroup>
          </div>

          {draftMode !== "all" && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium">Models</p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[11px]"
                  onClick={() => setDraftModels([])}
                  disabled={normalizedDraftModels.length === 0}
                >
                  Clear
                </Button>
              </div>

              <Popover open={modelPickerOpen} onOpenChange={setModelPickerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className="h-8 w-full justify-between px-2.5 text-xs"
                    disabled={isSaving}
                  >
                    <span className="truncate">
                      {normalizedDraftModels.length > 0
                        ? `${normalizedDraftModels.length} model selected`
                        : "Select models"}
                    </span>
                    <ChevronDown className="h-3 w-3 text-muted-foreground" />
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
                                  "h-3 w-3",
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

              <div className="max-h-28 overflow-y-auto rounded-md border border-border bg-muted/20 p-1.5">
                {normalizedDraftModels.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground px-1">No models selected</p>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {normalizedDraftModels.map((modelId) => (
                      <Badge key={modelId} variant="secondary" className="max-w-full gap-0.5 pr-0.5 font-normal text-[10px] py-0">
                        <span className="min-w-0 truncate font-mono">{modelId}</span>
                        <button
                          type="button"
                          className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm text-muted-foreground cursor-pointer hover:text-foreground"
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

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={isSaving || !hasChanges}>
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
