import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import { api } from "~/api";
import { errorText, settle } from "~/lib/settle";
import { UiBadge } from "~/components/ui/UiBadge";
import { UiButton } from "~/components/ui/UiButton";
import { UiIcon } from "~/components/ui/UiIcon";
import { UiPopover } from "~/components/ui/UiPopover";
import { asButtonProps } from "~/components/ui/trigger";
import { UiTooltip } from "~/components/ui/UiTooltip";

export interface RateLimitRule {
  target: string;
  targetType: "model" | "family";
  perMinute: number | null;
  perHour: number | null;
  perDay: number | null;
}

interface RuleState {
  target: string;
  targetType: "model" | "family";
  perMinute: string;
  perHour: string;
  perDay: string;
}

export interface ApiKeyRateLimitProps {
  apiKeyId: string;
  availableModels: string[];
  availableFamilies: string[];
  initialRules: RateLimitRule[];
  readonly?: boolean;
  onUpdated: (rules: RateLimitRule[]) => void;
}

function toState(rule: RateLimitRule): RuleState {
  return {
    target: rule.target,
    targetType: rule.targetType,
    perMinute: rule.perMinute != null ? String(rule.perMinute) : "",
    perHour: rule.perHour != null ? String(rule.perHour) : "",
    perDay: rule.perDay != null ? String(rule.perDay) : "",
  };
}

function toRule(state: RuleState): RateLimitRule {
  return {
    target: state.target,
    targetType: state.targetType,
    perMinute: state.perMinute ? Number.parseInt(state.perMinute, 10) : null,
    perHour: state.perHour ? Number.parseInt(state.perHour, 10) : null,
    perDay: state.perDay ? Number.parseInt(state.perDay, 10) : null,
  };
}

function rulesEqual(left: RateLimitRule[], right: RateLimitRule[]): boolean {
  if (left.length !== right.length) return false;
  const serialize = (rule: RateLimitRule) =>
    `${rule.targetType}:${rule.target}:${rule.perMinute}:${rule.perHour}:${rule.perDay}`;
  const leftSet = new Set(left.map(serialize));
  return right.every((rule) => leftSet.has(serialize(rule)));
}

const INPUT_CLASS =
  "mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60";

export function ApiKeyRateLimit(props: ApiKeyRateLimitProps): JSX.Element {
  const [isSaving, setIsSaving] = createSignal(false);
  const [savedRules, setSavedRules] = createSignal<RateLimitRule[]>(props.initialRules);
  const [draftRules, setDraftRules] = createSignal<RuleState[]>(props.initialRules.map(toState));
  const [addMode, setAddMode] = createSignal<"model" | "family">("model");
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [search, setSearch] = createSignal("");
  const [errorMessage, setErrorMessage] = createSignal("");

  function resetDraft() {
    setDraftRules(savedRules().map(toState));
    setPickerOpen(false);
    setAddMode("model");
    setSearch("");
    setErrorMessage("");
  }

  function addRule(target: string) {
    if (props.readonly) return;
    if (usedTargets().has(`${addMode()}:${target}`)) return;
    setDraftRules([...draftRules(), { target, targetType: addMode(), perMinute: "", perHour: "", perDay: "" }]);
    setPickerOpen(false);
    setSearch("");
  }

  function removeRule(index: number) {
    if (props.readonly) return;
    setDraftRules(draftRules().filter((_, ruleIndex) => ruleIndex !== index));
  }

  function updateRule(index: number, field: "perMinute" | "perHour" | "perDay", value: string) {
    if (props.readonly) return;
    if (value !== "" && !/^\d+$/.test(value)) return;
    setDraftRules(draftRules().map((rule, ruleIndex) => (ruleIndex === index ? { ...rule, [field]: value } : rule)));
  }

  async function save() {
    if (props.readonly) return;
    const rules = draftRules().map(toRule);
    for (const rule of rules) {
      if (rule.perMinute == null && rule.perHour == null && rule.perDay == null) {
        setErrorMessage(`Set at least one limit for ${rule.target}`);
        return;
      }
    }

    setIsSaving(true);
    setErrorMessage("");
    const updated = await settle(() => api.apiKeys.updateRateLimits({ id: props.apiKeyId, rules }));
    setIsSaving(false);
    if (!updated.ok) {
      setErrorMessage(errorText(updated.error, "Failed to update rate limits"));
      return;
    }
    if (!updated.value.success) {
      setErrorMessage(updated.value.error);
      return;
    }
    const result = updated.value;
    setSavedRules(result.data.rules);
    setDraftRules(result.data.rules.map(toState));
    setPickerOpen(false);
    props.onUpdated(result.data.rules);
  }

  const usedTargets = createMemo(() => new Set(draftRules().map((rule) => `${rule.targetType}:${rule.target}`)));
  const hasChanges = createMemo(() => !rulesEqual(savedRules(), draftRules().map(toRule)));
  const pickerItems = createMemo(() => {
    const source = addMode() === "model" ? props.availableModels : props.availableFamilies;
    const query = search().trim().toLowerCase();
    return source
      .filter((item) => !usedTargets().has(`${addMode()}:${item}`))
      .filter((item) => !query || item.toLowerCase().includes(query));
  });

  return (
    <section class="flex h-full flex-col">
      <div class="flex-1 space-y-3">
        <Show
          when={draftRules().length > 0}
          fallback={
            <div class="px-1 py-4 text-xs text-muted-foreground">
              No rate limits configured. Requests use the default unlimited behavior.
            </div>
          }
        >
          <div class="max-h-64 space-y-2 overflow-y-auto pr-1">
            <For each={draftRules()}>
              {(rule, index) => (
                <div class="border-b border-border/60 pb-3">
                  <div class="flex items-center justify-between gap-2">
                    <div class="flex min-w-0 items-center gap-1.5">
                      <UiBadge variant="outline" class="shrink-0 text-[10px]">
                        {rule.targetType === "family" ? "Family" : "Model"}
                      </UiBadge>
                      <span class="truncate font-mono text-xs">{rule.target}</span>
                    </div>
                    <UiTooltip text="Remove" disabled={props.readonly}>
                      <UiButton
                        variant="ghost"
                        size="sm"
                        class="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                        disabled={isSaving() || props.readonly}
                        aria-label="Remove rate limit rule"
                        onClick={() => removeRule(index())}
                      >
                        <UiIcon name="i-lucide-trash-2" class="size-3.5" />
                      </UiButton>
                    </UiTooltip>
                  </div>
                  <div class="mt-3 grid grid-cols-3 gap-2">
                    <label class="text-[10px] text-muted-foreground">
                      / minute
                      <input
                        value={rule.perMinute}
                        placeholder="--"
                        disabled={props.readonly}
                        class={INPUT_CLASS}
                        onInput={(event) => updateRule(index(), "perMinute", event.currentTarget.value)}
                      />
                    </label>
                    <label class="text-[10px] text-muted-foreground">
                      / hour
                      <input
                        value={rule.perHour}
                        placeholder="--"
                        disabled={props.readonly}
                        class={INPUT_CLASS}
                        onInput={(event) => updateRule(index(), "perHour", event.currentTarget.value)}
                      />
                    </label>
                    <label class="text-[10px] text-muted-foreground">
                      / day
                      <input
                        value={rule.perDay}
                        placeholder="--"
                        disabled={props.readonly}
                        class={INPUT_CLASS}
                        onInput={(event) => updateRule(index(), "perDay", event.currentTarget.value)}
                      />
                    </label>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>

        <div class="space-y-2 pt-1">
          <div class="flex items-center justify-between gap-2">
            <p class="text-xs font-medium">Add rule</p>
            <div class="grid grid-cols-2 gap-1 rounded-md border border-border/70 bg-card/30 p-1">
              <button
                type="button"
                disabled={props.readonly}
                class={`h-7 rounded-sm border px-2 text-[11px] font-medium disabled:cursor-default disabled:pointer-events-none disabled:opacity-60 ${
                  addMode() === "model" ? "border-primary/35 bg-primary/10 text-primary" : "border-transparent text-muted-foreground"
                }`}
                onClick={() => {
                  setAddMode("model");
                  setPickerOpen(false);
                }}
              >
                Model
              </button>
              <button
                type="button"
                disabled={props.readonly}
                class={`h-7 rounded-sm border px-2 text-[11px] font-medium disabled:cursor-default disabled:pointer-events-none disabled:opacity-60 ${
                  addMode() === "family" ? "border-primary/35 bg-primary/10 text-primary" : "border-transparent text-muted-foreground"
                }`}
                onClick={() => {
                  setAddMode("family");
                  setPickerOpen(false);
                }}
              >
                Family
              </button>
            </div>
          </div>

          <UiPopover
            open={pickerOpen()}
            onOpenChange={setPickerOpen}
            align="start"
            contentClass="w-[min(90vw,28rem)] p-0"
            trigger={(triggerProps) => (
              <UiButton
                {...asButtonProps(triggerProps)}
                variant="outline"
                class="h-9 w-full justify-between px-3 text-xs"
                disabled={isSaving() || pickerItems().length === 0 || props.readonly}
              >
                <span class="flex items-center gap-1.5 text-muted-foreground">
                  <UiIcon name="i-lucide-plus" class="size-3.5" />
                  {pickerItems().length === 0
                    ? `No ${addMode()} left to add`
                    : `Select ${addMode() === "model" ? "model" : "family"}`}
                </span>
                <UiIcon name="i-lucide-chevron-down" class="size-3.5 text-muted-foreground" />
              </UiButton>
            )}
            content={
              <>
                <div class="border-b border-border p-2">
                  <input
                    value={search()}
                    onInput={(event) => setSearch(event.currentTarget.value)}
                    placeholder={`Search ${addMode()}...`}
                    class="h-8 w-full rounded-md bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </div>
                <div class="max-h-72 overflow-y-auto p-1">
                  <For each={pickerItems()}>
                    {(item) => (
                      <button
                        type="button"
                        disabled={props.readonly}
                        class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent disabled:cursor-default disabled:pointer-events-none disabled:opacity-60"
                        onClick={() => addRule(item)}
                      >
                        <span class="truncate font-mono text-[11px]">{item}</span>
                      </button>
                    )}
                  </For>
                  <Show when={pickerItems().length === 0}>
                    <p class="px-2 py-6 text-center text-xs text-muted-foreground">No {addMode()} found.</p>
                  </Show>
                </div>
              </>
            }
          />
        </div>
        <Show when={errorMessage()}>
          <p class="text-xs text-destructive">{errorMessage()}</p>
        </Show>
      </div>

      <div class="flex items-center justify-end gap-2 border-t border-border/60 pt-3 lg:mt-4">
        <UiButton variant="outline" size="sm" disabled={isSaving() || !hasChanges() || props.readonly} onClick={resetDraft}>
          Cancel
        </UiButton>
        <UiButton size="sm" disabled={isSaving() || !hasChanges() || props.readonly} onClick={() => void save()}>
          {isSaving() ? "Saving..." : "Save"}
        </UiButton>
      </div>
    </section>
  );
}
