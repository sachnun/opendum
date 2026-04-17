"use client";

import { useMemo, useState } from "react";
import {
  ChevronDown,
  Gauge,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  updateApiKeyRateLimits,
  type RateLimitRuleInput,
} from "@/lib/actions/api-keys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";

interface RateLimitRuleState {
  target: string;
  targetType: "model" | "family";
  perMinute: string;
  perHour: string;
  perDay: string;
}

interface ApiKeyRateLimitProps {
  apiKeyId: string;
  availableModels: string[];
  availableFamilies: string[];
  initialRules: RateLimitRuleInput[];
}

function ruleToState(rule: RateLimitRuleInput): RateLimitRuleState {
  return {
    target: rule.target,
    targetType: rule.targetType,
    perMinute: rule.perMinute != null ? String(rule.perMinute) : "",
    perHour: rule.perHour != null ? String(rule.perHour) : "",
    perDay: rule.perDay != null ? String(rule.perDay) : "",
  };
}

function stateToRule(state: RateLimitRuleState): RateLimitRuleInput {
  return {
    target: state.target,
    targetType: state.targetType,
    perMinute: state.perMinute ? parseInt(state.perMinute, 10) : null,
    perHour: state.perHour ? parseInt(state.perHour, 10) : null,
    perDay: state.perDay ? parseInt(state.perDay, 10) : null,
  };
}

function rulesEqual(
  a: RateLimitRuleInput[],
  b: RateLimitRuleInput[]
): boolean {
  if (a.length !== b.length) return false;
  const serialize = (r: RateLimitRuleInput) =>
    `${r.targetType}:${r.target}:${r.perMinute}:${r.perHour}:${r.perDay}`;
  const setA = new Set(a.map(serialize));
  return b.every((r) => setA.has(serialize(r)));
}

export function ApiKeyRateLimit({
  apiKeyId,
  availableModels,
  availableFamilies,
  initialRules,
}: ApiKeyRateLimitProps) {
  const [open, setOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const [savedRules, setSavedRules] =
    useState<RateLimitRuleInput[]>(initialRules);
  const [draftRules, setDraftRules] = useState<RateLimitRuleState[]>(
    initialRules.map(ruleToState)
  );

  // For new rule addition
  const [addMode, setAddMode] = useState<"model" | "family">("model");
  const [pickerOpen, setPickerOpen] = useState(false);

  const usedTargets = useMemo(
    () => new Set(draftRules.map((r) => `${r.targetType}:${r.target}`)),
    [draftRules]
  );

  const hasChanges = !rulesEqual(
    savedRules,
    draftRules.map(stateToRule)
  );

  const resetDraft = () => {
    setDraftRules(savedRules.map(ruleToState));
    setPickerOpen(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) resetDraft();
    setOpen(nextOpen);
  };

  const addRule = (target: string) => {
    const key = `${addMode}:${target}`;
    if (usedTargets.has(key)) return;
    setDraftRules((prev) => [
      ...prev,
      {
        target,
        targetType: addMode,
        perMinute: "",
        perHour: "",
        perDay: "",
      },
    ]);
    setPickerOpen(false);
  };

  const removeRule = (idx: number) => {
    setDraftRules((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateRule = (
    idx: number,
    field: "perMinute" | "perHour" | "perDay",
    value: string
  ) => {
    // Only allow digits or empty
    if (value !== "" && !/^\d+$/.test(value)) return;
    setDraftRules((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, [field]: value } : r))
    );
  };

  const handleSave = async () => {
    const rules = draftRules.map(stateToRule);

    // Client-side validation
    for (const rule of rules) {
      if (rule.perMinute == null && rule.perHour == null && rule.perDay == null) {
        toast.error(`Set at least one limit for ${rule.target}`);
        return;
      }
    }

    setIsSaving(true);
    try {
      const result = await updateApiKeyRateLimits(apiKeyId, rules);
      if (!result.success) {
        throw new Error(result.error);
      }
      setSavedRules(result.data.rules);
      setDraftRules(result.data.rules.map(ruleToState));
      setOpen(false);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to update rate limits"
      );
    } finally {
      setIsSaving(false);
    }
  };

  const pickerItems =
    addMode === "model"
      ? availableModels.filter(
          (m) => !usedTargets.has(`model:${m}`)
        )
      : availableFamilies.filter(
          (f) => !usedTargets.has(`family:${f}`)
        );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground cursor-pointer"
        >
          <Gauge className="h-3 w-3" />
          <span>Rate Limits</span>
          {savedRules.length > 0 && (
            <span className="text-muted-foreground/70">
              ({savedRules.length})
            </span>
          )}
        </button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Rate Limits</DialogTitle>
          <DialogDescription className="sr-only">
            Configure per-model or per-family rate limits for this API key.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {/* Existing rules */}
          {draftRules.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">
              No rate limits configured. All models are unlimited.
            </p>
          ) : (
            <div className="space-y-2 max-h-[320px] overflow-y-auto">
              {draftRules.map((rule, idx) => (
                <div
                  key={`${rule.targetType}:${rule.target}`}
                  className="rounded-md border border-border p-2.5 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <Badge
                        variant="outline"
                        className="shrink-0 text-[10px] px-1.5 py-0"
                      >
                        {rule.targetType === "family"
                          ? "Family"
                          : "Model"}
                      </Badge>
                      <span className="text-xs font-mono truncate">
                        {rule.target}
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive shrink-0"
                      onClick={() => removeRule(idx)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <Label className="text-[10px] text-muted-foreground">
                        / minute
                      </Label>
                      <Input
                        className="h-7 text-xs mt-0.5"
                        placeholder="--"
                        value={rule.perMinute}
                        onChange={(e) =>
                          updateRule(idx, "perMinute", e.target.value)
                        }
                      />
                    </div>
                    <div>
                      <Label className="text-[10px] text-muted-foreground">
                        / hour
                      </Label>
                      <Input
                        className="h-7 text-xs mt-0.5"
                        placeholder="--"
                        value={rule.perHour}
                        onChange={(e) =>
                          updateRule(idx, "perHour", e.target.value)
                        }
                      />
                    </div>
                    <div>
                      <Label className="text-[10px] text-muted-foreground">
                        / day
                      </Label>
                      <Input
                        className="h-7 text-xs mt-0.5"
                        placeholder="--"
                        value={rule.perDay}
                        onChange={(e) =>
                          updateRule(idx, "perDay", e.target.value)
                        }
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Add new rule */}
          <div className="space-y-1.5 border-t pt-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium">Add Rule</p>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={addMode}
                onValueChange={(v) => {
                  if (v === "model" || v === "family") {
                    setAddMode(v);
                    setPickerOpen(false);
                  }
                }}
              >
                <ToggleGroupItem
                  value="model"
                  className="h-6 text-[11px] px-2"
                >
                  Model
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="family"
                  className="h-6 text-[11px] px-2"
                >
                  Family
                </ToggleGroupItem>
              </ToggleGroup>
            </div>

            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className="h-8 w-full justify-between px-2.5 text-xs"
                  disabled={isSaving}
                >
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <Plus className="h-3 w-3" />
                    Select {addMode === "model" ? "model" : "family"}
                  </span>
                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="w-[min(90vw,28rem)] p-0"
              >
                <Command>
                  <CommandInput
                    placeholder={`Search ${addMode}...`}
                  />
                  <CommandList>
                    <CommandEmpty>
                      No {addMode} found.
                    </CommandEmpty>
                    <CommandGroup>
                      {pickerItems.map((item) => (
                        <CommandItem
                          key={item}
                          value={item}
                          onSelect={() => addRule(item)}
                          className="gap-2"
                        >
                          <span className="truncate font-mono text-[11px]">
                            {item}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={isSaving || !hasChanges}
          >
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
