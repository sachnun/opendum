import { For, Show, createEffect, createMemo, createSignal, on, type JSX } from "solid-js";
import { api } from "~/api";
import { dataKeys } from "~/lib/data-keys";
import { createQuery } from "~/lib/query";
import { UiIcon } from "~/components/ui/UiIcon";
import { UiPopover } from "~/components/ui/UiPopover";
import { asButtonProps } from "~/components/ui/trigger";

export interface ModelAliasSelectProps {
  modelValue: string;
  defaultId?: string;
  onValueChange: (value: string) => void;
}

const MAX_RESULTS = 200;

export function ModelAliasSelect(props: ModelAliasSelectProps): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [search, setSearch] = createSignal("");
  let searchInput: HTMLInputElement | undefined;

  const catalogQuery = createQuery(dataKeys.modelCatalog, () => api.models.catalog(), { defaultValue: [] as string[] });
  const models = () => catalogQuery.data() ?? [];
  const filteredModels = createMemo(() => {
    const term = search().trim().toLowerCase();
    const matched = term ? models().filter((id) => id.toLowerCase().includes(term)) : models();
    return matched.slice(0, MAX_RESULTS);
  });

  createEffect(
    on(open, (value) => {
      setSearch("");
      if (value) queueMicrotask(() => searchInput?.focus());
    })
  );

  function select(value: string) {
    props.onValueChange(value);
    setOpen(false);
  }

  return (
    <UiPopover
      open={open()}
      onOpenChange={setOpen}
      align="start"
      contentClass="w-[min(90vw,28rem)] p-0"
      trigger={(triggerProps) => (
        <button
          {...asButtonProps(triggerProps)}
          type="button"
          class="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-left text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <span class={`truncate font-mono text-xs ${props.modelValue ? "" : "text-muted-foreground"}`}>
            {props.modelValue || "None"}
          </span>
          <UiIcon name="i-lucide-chevron-down" class="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      )}
      content={
        <>
          <div class="border-b border-border p-2">
            <input
              ref={searchInput}
              value={search()}
              onInput={(event) => setSearch(event.currentTarget.value)}
              placeholder="Search model..."
              class="h-8 w-full rounded-md bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <div class="max-h-72 overflow-y-auto p-1">
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent"
              onClick={() => select("")}
            >
              <UiIcon name="i-lucide-check" class={`size-3.5 ${props.modelValue ? "opacity-0" : "opacity-100"}`} />
              <span class="truncate text-xs text-muted-foreground">
                None
                <Show when={props.defaultId}>
                  <span> · uses {props.defaultId}</span>
                </Show>
              </span>
            </button>
            <For each={filteredModels()}>
              {(id) => (
                <button
                  type="button"
                  class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent"
                  onClick={() => select(id)}
                >
                  <UiIcon name="i-lucide-check" class={`size-3.5 ${props.modelValue === id ? "opacity-100" : "opacity-0"}`} />
                  <span class="truncate font-mono text-[11px]">{id}</span>
                </button>
              )}
            </For>
            <Show when={filteredModels().length === 0}>
              <p class="px-2 py-6 text-center text-xs text-muted-foreground">
                {catalogQuery.pending() ? "Loading models..." : "No model found."}
              </p>
            </Show>
          </div>
        </>
      }
    />
  );
}
