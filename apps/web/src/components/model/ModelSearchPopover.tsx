import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, type JSX } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import { labelOf } from "@opendum/providers/provider-accounts";
import type { ModelSearchItem } from "~/lib/api-types";
import { api } from "~/api";
import { dataKeys } from "~/lib/data-keys";
import { createQuery } from "~/lib/query";
import { Routes } from "~/lib/routes";
import { UiBadge } from "~/components/ui/UiBadge";
import { UiIcon } from "~/components/ui/UiIcon";
import { UiTooltip } from "~/components/ui/UiTooltip";

const MAX_SUGGESTIONS = 50;
const SUGGESTION_LIST_ID = "model-search-suggestions";

export function ModelSearchPopover(props: { onFocusChange?: (focused: boolean) => void }): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();

  let root: HTMLDivElement | undefined;
  let searchInput: HTMLInputElement | undefined;
  const [suggestionsOpen, setSuggestionsOpen] = createSignal(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = createSignal(-1);
  const [search, setSearch] = createSignal("");
  const [placeholderModelIndex, setPlaceholderModelIndex] = createSignal(0);
  const [modelsRequested, setModelsRequested] = createSignal(false);
  let placeholderTimer: number | null = null;

  const searchQuery = createQuery<ModelSearchItem[]>(dataKeys.modelSearch, () => api.models.search(), {
    defaultValue: [],
    immediate: false,
  });

  const models = () => searchQuery.data() ?? [];
  const placeholderModels = createMemo(() =>
    models()
      .filter((model) => model.isEnabled !== false)
      .map((model) => model.id)
      .slice(0, 24)
  );
  const activePlaceholderModel = createMemo(() => placeholderModels()[placeholderModelIndex()] ?? null);
  const showAnimatedPlaceholder = createMemo(() => search().length === 0 && activePlaceholderModel() !== null);
  const matchedModels = createMemo(() => {
    const term = search().trim().toLowerCase();
    if (!term) return models();

    return models().filter((model) => {
      const providers = model.providers.map(labelOf).join(" ");
      return `${model.id} ${providers}`.toLowerCase().includes(term);
    });
  });
  const filteredModels = createMemo(() => matchedModels().slice(0, MAX_SUGGESTIONS));
  const hasMoreMatches = createMemo(() => matchedModels().length > filteredModels().length);
  const activeSuggestionModel = createMemo(() => filteredModels()[activeSuggestionIndex()] ?? null);

  createEffect(
    on(filteredModels, (items) => {
      if (items.length === 0) {
        setActiveSuggestionIndex(-1);
        return;
      }

      if (activeSuggestionIndex() < 0 || activeSuggestionIndex() >= items.length) {
        setActiveSuggestionIndex(0);
      }
    })
  );

  createEffect(
    on(placeholderModels, (items) => {
      if (placeholderModelIndex() >= items.length) setPlaceholderModelIndex(0);
    })
  );

  createEffect(
    on(
      () => location.pathname + location.search + location.hash,
      () => {
        setSuggestionsOpen(false);
        setActiveSuggestionIndex(-1);
        setSearch("");
      }
    )
  );

  onMount(() => {
    placeholderTimer = window.setInterval(() => {
      const total = placeholderModels().length;
      if (total <= 1) return;
      setPlaceholderModelIndex((placeholderModelIndex() + 1) % total);
    }, 2600);
  });

  onCleanup(() => {
    if (placeholderTimer) window.clearInterval(placeholderTimer);
  });

  function ensureLoaded() {
    if (modelsRequested() || models().length > 0) return;
    setModelsRequested(true);
    void searchQuery.refresh();
  }

  function openSuggestions() {
    ensureLoaded();
    props.onFocusChange?.(true);
    setSuggestionsOpen(true);
    if (filteredModels().length > 0 && activeSuggestionIndex() === -1) {
      setActiveSuggestionIndex(0);
    }
  }

  function closeSuggestions() {
    setSuggestionsOpen(false);
    setActiveSuggestionIndex(-1);
  }

  function focusOut(event: FocusEvent) {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && root?.contains(nextTarget)) return;
    props.onFocusChange?.(false);
    closeSuggestions();
  }

  function moveSuggestion(delta: number) {
    openSuggestions();
    const total = filteredModels().length;
    if (total === 0) return;

    const currentIndex = activeSuggestionIndex() === -1 ? 0 : activeSuggestionIndex();
    setActiveSuggestionIndex((currentIndex + delta + total) % total);
  }

  function selectSuggestion() {
    if (!suggestionsOpen()) return;
    const model = activeSuggestionModel() ?? filteredModels()[0];
    if (model) void selectModel(model);
  }

  function clearSearch() {
    setSearch("");
    openSuggestions();
  }

  async function selectModel(model: ModelSearchItem) {
    searchInput?.blur();
    closeSuggestions();
    navigate(`${Routes.models}#model-${encodeURIComponent(model.id)}`);
  }

  return (
    <div ref={root} class="relative w-full max-w-xl" onFocusOut={focusOut}>
      <label for="model-search-input" class="sr-only">
        Search models
      </label>
      <div class="relative">
        <UiIcon name="i-lucide-search" class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          id="model-search-input"
          ref={searchInput}
          value={search()}
          type="text"
          role="combobox"
          aria-expanded={suggestionsOpen()}
          aria-controls={SUGGESTION_LIST_ID}
          aria-activedescendant={activeSuggestionModel() ? `model-search-option-${activeSuggestionIndex()}` : undefined}
          aria-autocomplete="list"
          class="h-9 w-full rounded-lg border border-border bg-background pl-9 pr-9 text-xs font-normal shadow-xs outline-none transition-all placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:text-sm"
          placeholder={showAnimatedPlaceholder() ? "" : "Search models..."}
          autocomplete="off"
          onFocus={openSuggestions}
          onInput={(event) => {
            setSearch(event.currentTarget.value);
            openSuggestions();
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              moveSuggestion(1);
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              moveSuggestion(-1);
            }
            if (event.key === "Enter") {
              event.preventDefault();
              selectSuggestion();
            }
            if (event.key === "Escape") {
              event.stopPropagation();
              closeSuggestions();
            }
          }}
        />
        <Show when={showAnimatedPlaceholder()}>
          <span
            aria-hidden="true"
            class="pointer-events-none absolute left-9 right-9 top-1/2 -translate-y-1/2 truncate text-xs text-muted-foreground sm:text-sm"
          >
            {activePlaceholderModel()}
          </span>
        </Show>
        <Show when={search()}>
          <UiTooltip text="Clear">
            <button
              type="button"
              class="absolute right-2 top-1/2 flex size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Clear model search"
              onMouseDown={(event) => event.preventDefault()}
              onClick={clearSearch}
            >
              <UiIcon name="i-lucide-x" class="size-3.5" />
            </button>
          </UiTooltip>
        </Show>
      </div>

      <Show when={suggestionsOpen()}>
        <div
          id={SUGGESTION_LIST_ID}
          role="listbox"
          class="absolute left-0 right-0 top-full z-40 mt-1 max-h-[min(22rem,calc(100vh-5rem))] overflow-y-auto rounded-lg border border-border bg-background p-1 text-foreground shadow-lg"
        >
          <Show
            when={filteredModels().length > 0}
            fallback={
              <p class="py-6 text-center text-sm text-muted-foreground">
                {searchQuery.pending() ? "Loading models..." : "No model found."}
              </p>
            }
          >
            <div class="space-y-1">
              <p class="px-2 py-1.5 text-xs font-medium text-muted-foreground">Models</p>
              <For each={filteredModels()}>
                {(model, index) => (
                  <button
                    id={`model-search-option-${index()}`}
                    type="button"
                    role="option"
                    aria-selected={activeSuggestionIndex() === index()}
                    class={`flex w-full cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors [contain-intrinsic-size:auto_3.25rem] [content-visibility:auto] ${
                      activeSuggestionIndex() === index()
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent hover:text-accent-foreground"
                    }`}
                    onMouseEnter={() => setActiveSuggestionIndex(index())}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      void selectModel(model);
                    }}
                  >
                    <div class="min-w-0 flex-1">
                      <p class="truncate font-mono text-xs sm:text-sm">{model.id}</p>
                      <div class="mt-1 flex flex-wrap gap-1.5">
                        <For each={model.providers}>
                          {(provider) => (
                            <UiBadge variant="outline" class="text-[10px] font-normal">
                              {labelOf(provider)}
                            </UiBadge>
                          )}
                        </For>
                      </div>
                    </div>
                  </button>
                )}
              </For>
              <Show when={hasMoreMatches()}>
                <p class="px-2 py-1.5 text-xs text-muted-foreground">Refine your search to see more.</p>
              </Show>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
