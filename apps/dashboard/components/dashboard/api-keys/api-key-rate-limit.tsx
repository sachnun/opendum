"use client";

import { useMemo, useState } from "react";
import {
  ChevronDown,
  Gauge,
  Plus,
  RotateCcw,
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
  if (a.length !== b.length) {
    return false;
  }

  const serialize = (rule: RateLimitRuleInput) =>
    `${rule.targetType}:${rule.target}:${rule.perMinute}:${rule.perHour}:${rule.perDay}`;
  const setA = new Set(a.map(serialize));
  return b.every((rule) => setA.has(serialize(rule)));
}

function formatRuleSummary(rule: RateLimitRuleInput): string {
  const parts: string[] = [];

  if (rule.perMinute != null) {
    parts.push(`${rule.perMinute}/m`);
  }

  if (rule.perHour != null) {
    parts.push(`${rule.perHour}/h`);
  }

  if (rule.perDay != null) {
    parts.push(`${rule.perDay}/d`);
  }

  return parts.length > 0 ? parts.join(" | ") : "Unlimited";
}

export function ApiKeyRateLimit({
  apiKeyId,
  availableModels,
  availableFamilies,
  initialRules,
}: ApiKeyRateLimitProps) {
  const [isSaving, setIsSaving] = useState(false);

  const [savedRules, setSavedRules] = useState<RateLimitRuleInput[]>(initialRules);
  const [draftRules, setDraftRules] = useState<RateLimitRuleState[]>(
    initialRules.map(ruleToState)
  );

  const [addMode, setAddMode] = useState<"model" | "family">("model");
  const [pickerOpen, setPickerOpen] = useState(false);

  const usedTargets = useMemo(
    () => new Set(draftRules.map((rule) => `${rule.targetType}:${rule.target}`)),
    [draftRules]
  );

  const hasChanges = !rulesEqual(savedRules, draftRules.map(stateToRule));

  const resetDraft = () => {
    setDraftRules(savedRules.map(ruleToState));
    setPickerOpen(false);
    setAddMode("model");
  };

  const addRule = (target: string) => {
    const key = `${addMode}:${target}`;
    if (usedTargets.has(key)) {
      return;
    }

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
    setDraftRules((prev) => prev.filter((_, index) => index !== idx));
  };

  const updateRule = (
    idx: number,
    field: "perMinute" | "perHour" | "perDay",
    value: string
  ) => {
    if (value !== "" && !/^\d+$/.test(value)) {
      return;
    }

    setDraftRules((prev) =>
      prev.map((rule, index) => (index === idx ? { ...rule, [field]: value } : rule))
    );
  };

  const handleSave = async () => {
    const rules = draftRules.map(stateToRule);

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
      setPickerOpen(false);
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
      ? availableModels.filter((model) => !usedTargets.has(`model:${model}`))
      : availableFamilies.filter((family) => !usedTargets.has(`family:${family}`));

  return (
    <section className="flex h-full flex-col rounded-xl border border-border/70 bg-muted/20 p-4 lg:border lg:border-border/70 lg:bg-muted/20 max-lg:border-0 max-lg:bg-transparent max-lg:p-0">
      <div className="hidden items-start justify-between gap-3 lg:flex">
        <div className="inline-flex items-center gap-2 text-sm font-semibold">
          <Gauge className="h-4 w-4 text-muted-foreground" />
          <span>Rate Limits</span>
        </div>
        <Badge variant="outline" className="shrink-0">
          {savedRules.length} rule{savedRules.length === 1 ? "" : "s"}
        </Badge>
      </div>

      <div className="rounded-lg border border-border/60 bg-background/80 p-3 text-xs lg:mt-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted-foreground">Current rules</p>
          <span className="font-medium">
            {savedRules.length === 0 ? "Unlimited" : `${savedRules.length} active`}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {savedRules.length === 0 ? (
            <Badge variant="secondary" className="font-normal">
              No custom limits
            </Badge>
          ) : (
            savedRules.slice(0, 3).map((rule) => (
              <Badge
                key={`${rule.targetType}:${rule.target}`}
                variant="secondary"
                className="max-w-full gap-1 font-normal"
              >
                <span className="truncate font-mono text-[10px]">{rule.target}</span>
                <span className="text-[10px] text-muted-foreground">{formatRuleSummary(rule)}</span>
              </Badge>
            ))
          )}
          {savedRules.length > 3 && (
            <Badge variant="outline">+{savedRules.length - 3} more</Badge>
          )}
        </div>
      </div>

      <div className="space-y-3 flex-1 lg:mt-4">
        {draftRules.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/70 bg-background/60 px-3 py-6 text-center text-xs text-muted-foreground">
            No rate limits configured. Requests use the default unlimited behavior.
          </div>
        ) : (
          <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
            {draftRules.map((rule, idx) => (
              <div
                key={`${rule.targetType}:${rule.target}`}
                className="rounded-lg border border-border/60 bg-background/80 p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {rule.targetType === "family" ? "Family" : "Model"}
                    </Badge>
                    <span className="truncate font-mono text-xs">{rule.target}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                    onClick={() => removeRule(idx)}
                    disabled={isSaving}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>

                <div className="mt-3 grid grid-cols-3 gap-2">
                  <div>
                    <Label className="text-[10px] text-muted-foreground">/ minute</Label>
                    <Input
                      className="mt-1 h-8 text-xs"
                      placeholder="--"
                      value={rule.perMinute}
                      onChange={(event) => updateRule(idx, "perMinute", event.target.value)}
                    />
                  </div>
                  <div>
                    <Label className="text-[10px] text-muted-foreground">/ hour</Label>
                    <Input
                      className="mt-1 h-8 text-xs"
                      placeholder="--"
                      value={rule.perHour}
                      onChange={(event) => updateRule(idx, "perHour", event.target.value)}
                    />
                  </div>
                  <div>
                    <Label className="text-[10px] text-muted-foreground">/ day</Label>
                    <Input
                      className="mt-1 h-8 text-xs"
                      placeholder="--"
                      value={rule.perDay}
                      onChange={(event) => updateRule(idx, "perDay", event.target.value)}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="rounded-lg border border-border/60 bg-background/80 p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium">Add rule</p>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={addMode}
              onValueChange={(value) => {
                if (value === "model" || value === "family") {
                  setAddMode(value);
                  setPickerOpen(false);
                }
              }}
            >
              <ToggleGroupItem value="model" className="h-7 px-2 text-[11px]">
                Model
              </ToggleGroupItem>
              <ToggleGroupItem value="family" className="h-7 px-2 text-[11px]">
                Family
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className="h-9 w-full justify-between px-3 text-xs"
                disabled={isSaving || pickerItems.length === 0}
              >
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Plus className="h-3.5 w-3.5" />
                  {pickerItems.length === 0
                    ? `No ${addMode} left to add`
                    : `Select ${addMode === "model" ? "model" : "family"}`}
                </span>
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[min(90vw,28rem)] p-0">
              <Command>
                <CommandInput placeholder={`Search ${addMode}...`} />
                <CommandList>
                  <CommandEmpty>No {addMode} found.</CommandEmpty>
                  <CommandGroup>
                    {pickerItems.map((item) => (
                      <CommandItem
                        key={item}
                        value={item}
                        onSelect={() => addRule(item)}
                        className="gap-2"
                      >
                        <span className="truncate font-mono text-[11px]">{item}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border/60 pt-3 lg:mt-4">
        <Button
          variant="outline"
          size="sm"
          onClick={resetDraft}
          disabled={isSaving || !hasChanges}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Reset
        </Button>
        <Button
          size="sm"
          onClick={handleSave}
          disabled={isSaving || !hasChanges}
        >
          {isSaving ? "Saving..." : "Save"}
        </Button>
      </div>
    </section>
  );
}
