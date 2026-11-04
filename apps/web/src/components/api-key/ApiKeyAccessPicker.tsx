import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import { sameList, type AccessMode } from "~/lib/access-draft";
import { UiBadge } from "~/components/ui/UiBadge";
import { UiButton } from "~/components/ui/UiButton";
import { UiIcon } from "~/components/ui/UiIcon";
import { UiPopover } from "~/components/ui/UiPopover";
import { UiTooltip } from "~/components/ui/UiTooltip";
import { asButtonProps } from "~/components/ui/trigger";

export type AccessTarget = { id: string; label: string; detail?: string; mono?: boolean };

export interface AccessDraft {
  mode: AccessMode;
  ids: string[];
}

export interface ApiKeyAccessPickerProps {
  title: string;
  noun: string;
  targets: AccessTarget[];
  searchText: (target: AccessTarget) => string;
  initialMode: AccessMode;
  initialIds: string[];
  readonly?: boolean;
  normalize: (ids: string[]) => string[];
  mode: AccessMode;
  onModeChange: (mode: AccessMode) => void;
  ids: string[];
  onIdsChange: (ids: string[]) => void;
  saved: AccessDraft;
  isSaving: boolean;
  error: string;
  onSave: (value: { mode: AccessMode; ids: string[] }) => void;
}

const MODES: AccessMode[] = ["all", "whitelist", "blacklist"];

export function ApiKeyAccessPicker(props: ApiKeyAccessPickerProps): JSX.Element {
  const [search, setSearch] = createSignal("");
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [localError, setLocalError] = createSignal("");

  const normalizedIds = createMemo(() => props.normalize(props.ids));
  const idsForSave = createMemo(() => (props.mode === "all" ? [] : normalizedIds()));
  const savedIds = createMemo(() => (props.saved.mode === "all" ? [] : props.normalize(props.saved.ids)));
  const hasChanges = createMemo(() => props.mode !== props.saved.mode || !sameList(idsForSave(), savedIds()));
  const targetMap = createMemo(() => new Map(props.targets.map((target) => [target.id, target])));
  const filtered = createMemo(() => {
    const query = search().trim().toLowerCase();
    if (!query) return props.targets;
    return props.targets.filter((target) => props.searchText(target).toLowerCase().includes(query));
  });

  function toggle(id: string) {
    if (props.readonly) return;
    props.onIdsChange(
      props.ids.includes(id) ? props.ids.filter((entry) => entry !== id) : props.normalize([...props.ids, id])
    );
  }

  function clear() {
    if (props.readonly) return;
    props.onIdsChange([]);
  }

  function labelOf(id: string): string {
    return targetMap().get(id)?.label ?? id;
  }

  function reset() {
    props.onModeChange(props.saved.mode);
    props.onIdsChange([...props.saved.ids]);
    setPickerOpen(false);
    setSearch("");
    setLocalError("");
  }

  function submit() {
    if (props.readonly) return;
    if (props.mode !== "all" && idsForSave().length === 0) {
      setLocalError(`Select at least one ${props.noun}`);
      return;
    }
    props.onSave({ mode: props.mode, ids: idsForSave() });
  }

  return (
    <section class="flex h-full flex-col">
      <div class="flex-1 space-y-3">
        <div class="grid grid-cols-3 gap-1 rounded-md border border-border/70 bg-card/30 p-1">
          <For each={MODES}>
            {(entry) => (
              <button
                type="button"
                disabled={props.readonly}
                class={`h-8 rounded-sm border px-2 text-xs font-medium disabled:cursor-default disabled:pointer-events-none disabled:opacity-60 ${
                  props.mode === entry
                    ? "border-primary/35 bg-primary/10 text-primary"
                    : "border-transparent text-muted-foreground"
                }`}
                onClick={() => props.onModeChange(entry)}
              >
                {entry === "all" ? "All" : entry === "whitelist" ? "Whitelist" : "Blacklist"}
              </button>
            )}
          </For>
        </div>

        <Show when={props.mode !== "all"}>
          <div class="space-y-2">
            <div class="flex items-center justify-between gap-2">
              <p class="text-xs font-medium">{props.title}</p>
              <UiButton
                type="button"
                variant="ghost"
                size="sm"
                class="h-7 px-2 text-[11px]"
                disabled={normalizedIds().length === 0 || props.isSaving || props.readonly}
                onClick={clear}
              >
                Clear
              </UiButton>
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
                  disabled={props.isSaving || props.readonly}
                >
                  <span class="truncate">
                    {normalizedIds().length > 0 ? `${normalizedIds().length} ${props.noun} selected` : `Select ${props.noun}s`}
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
                      placeholder={`Search ${props.noun}...`}
                      class="h-8 w-full rounded-md bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </div>
                  <div class="max-h-72 overflow-y-auto p-1">
                    <For each={filtered()}>
                      {(target) => (
                        <button
                          type="button"
                          disabled={props.readonly}
                          class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent disabled:cursor-default disabled:pointer-events-none disabled:opacity-60"
                          onClick={() => toggle(target.id)}
                        >
                          <UiIcon
                            name="i-lucide-check"
                            class={`size-3.5 ${normalizedIds().includes(target.id) ? "opacity-100" : "opacity-0"}`}
                          />
                          <div class="flex min-w-0 flex-col">
                            <span class={`truncate text-xs font-medium ${target.mono ? "font-mono" : ""}`}>{target.label}</span>
                            <Show when={target.detail}>
                              <span class="truncate text-[11px] text-muted-foreground">{target.detail}</span>
                            </Show>
                          </div>
                        </button>
                      )}
                    </For>
                    <Show when={filtered().length === 0}>
                      <p class="px-2 py-6 text-center text-xs text-muted-foreground">No {props.noun} found.</p>
                    </Show>
                  </div>
                </>
              }
            />

            <div class="max-h-40 overflow-y-auto py-1">
              <Show
                when={normalizedIds().length > 0}
                fallback={<p class="px-1 text-[11px] text-muted-foreground">No {props.noun}s selected</p>}
              >
                <div class="flex flex-wrap gap-1.5">
                  <For each={normalizedIds()}>
                    {(targetId) => (
                      <UiBadge variant="outline" class="max-w-full gap-1 pr-1 text-[10px] font-normal">
                        <span class="min-w-0 truncate">{labelOf(targetId)}</span>
                        <UiTooltip text="Remove" disabled={props.readonly}>
                          <button
                            type="button"
                            disabled={props.readonly}
                            aria-label={`Remove ${props.noun} ${labelOf(targetId)}`}
                            class="inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground disabled:cursor-default disabled:pointer-events-none disabled:opacity-60"
                            onClick={() => toggle(targetId)}
                          >
                            <UiIcon name="i-lucide-x" class="size-2.5" />
                          </button>
                        </UiTooltip>
                      </UiBadge>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </div>
        </Show>
        <Show when={localError() || props.error}>
          <p class="text-xs text-destructive">{localError() || props.error}</p>
        </Show>
      </div>

      <div class="flex items-center justify-end gap-2 border-t border-border/60 pt-3 lg:mt-4">
        <UiButton variant="outline" size="sm" disabled={props.isSaving || !hasChanges() || props.readonly} onClick={reset}>
          Cancel
        </UiButton>
        <UiButton size="sm" disabled={props.isSaving || !hasChanges() || props.readonly} onClick={submit}>
          {props.isSaving ? "Saving..." : "Save"}
        </UiButton>
      </div>
    </section>
  );
}
