import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ModelSearchItem } from "../lib/dashboard-api-types";
import { useDashboardApi } from "../hooks/useDashboardApi";
import { dashboardDataKeys, useDashboardData } from "../hooks/useDashboardDataInvalidation";
import { getProviderLabel } from "../lib/provider-accounts";
import { UiBadge } from "./ui/UiBadge";
import { UiIcon } from "./ui/UiIcon";
import { UiTooltip } from "./ui/UiTooltip";
import { cn } from "../lib/utils";

export interface ModelSearchPopoverProps {
  onFocusChange?: (focused: boolean) => void;
}

const PLACEHOLDER_MODEL_IDS = ["gpt-5", "claude-opus-4-6", "gemini-3-pro-preview", "deepseek-r1", "qwen3-coder-plus", "llama-4-maverick"];

export function ModelSearchPopover({ onFocusChange }: ModelSearchPopoverProps) {
  const navigate = useNavigate();
  const dashboardApi = useDashboardApi();
  const { data: models } = useDashboardData<ModelSearchItem[]>(dashboardDataKeys.modelSearch, () => dashboardApi.models.search(), { enabled: true });
  const [search, setSearch] = useState("");
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
  const [placeholderModelIndex, setPlaceholderModelIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setPlaceholderModelIndex((index) => (index + 1) % PLACEHOLDER_MODEL_IDS.length);
    }, 2600);
    return () => window.clearInterval(timer);
  }, []);

  const showAnimatedPlaceholder = search === "" && Boolean(models?.length);
  const activePlaceholderModel = showAnimatedPlaceholder ? PLACEHOLDER_MODEL_IDS[placeholderModelIndex % PLACEHOLDER_MODEL_IDS.length] : null;

  const filteredModels = useMemo(() => {
    const items = models ?? [];
    const term = search.trim().toLowerCase();
    if (!term) return items;
    return items.filter((model) => {
      const providers = model.providers.map(getProviderLabel).join(" ");
      return `${model.id} ${providers}`.toLowerCase().includes(term);
    });
  }, [models, search]);

  useEffect(() => {
    if (filteredModels.length === 0) {
      setActiveSuggestionIndex(-1);
      return;
    }
    setActiveSuggestionIndex((current) => (current < 0 || current >= filteredModels.length ? 0 : current));
  }, [filteredModels]);

  const activeSuggestionModel = activeSuggestionIndex >= 0 ? filteredModels[activeSuggestionIndex] : undefined;

  const closeSuggestions = () => {
    setSuggestionsOpen(false);
    setActiveSuggestionIndex(-1);
  };

  const openSuggestions = () => {
    setSuggestionsOpen(true);
    if (filteredModels.length > 0 && activeSuggestionIndex === -1) {
      setActiveSuggestionIndex(0);
    }
  };

  const moveActiveSuggestion = (delta: number) => {
    openSuggestions();
    const total = filteredModels.length;
    if (total === 0) return;
    const currentIndex = activeSuggestionIndex === -1 ? 0 : activeSuggestionIndex;
    setActiveSuggestionIndex((currentIndex + delta + total) % total);
  };

  const selectModel = (model: ModelSearchItem) => {
    inputRef.current?.blur();
    closeSuggestions();
    onFocusChange?.(false);
    navigate(`/dashboard/models#model-${encodeURIComponent(model.id)}`);
  };

  const handleFocusOut = (event: React.FocusEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && rootRef.current?.contains(nextTarget)) return;
    onFocusChange?.(false);
    closeSuggestions();
  };

  return (
    <div ref={rootRef} className="relative w-full max-w-xl" onBlur={handleFocusOut}>
      <label htmlFor="model-search-input" className="sr-only">Search models</label>
      <div className="relative">
        <UiIcon name="i-lucide-search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          id="model-search-input"
          ref={inputRef}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            openSuggestions();
          }}
          type="text"
          role="combobox"
          aria-expanded={suggestionsOpen}
          aria-autocomplete="list"
          className="h-9 w-full rounded-lg border border-border bg-background pl-9 pr-9 text-xs font-normal shadow-xs outline-none transition-all placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:text-sm"
          placeholder={showAnimatedPlaceholder ? "" : "Search models..."}
          autoComplete="off"
          onFocus={() => {
            onFocusChange?.(true);
            openSuggestions();
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              moveActiveSuggestion(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              moveActiveSuggestion(-1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              const model = activeSuggestionModel ?? filteredModels[0];
              if (model && suggestionsOpen) selectModel(model);
            } else if (event.key === "Escape") {
              event.stopPropagation();
              closeSuggestions();
            }
          }}
        />
        {showAnimatedPlaceholder && activePlaceholderModel ? (
          <span aria-hidden="true" className="pointer-events-none absolute left-9 right-9 top-1/2 -translate-y-1/2 truncate text-xs text-muted-foreground sm:text-sm">
            {activePlaceholderModel}
          </span>
        ) : null}
        {search ? (
          <UiTooltip text="Clear">
            <button
              type="button"
              className="absolute right-2 top-1/2 flex size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Clear model search"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setSearch("");
                openSuggestions();
              }}
            >
              <UiIcon name="i-lucide-x" className="size-3.5" />
            </button>
          </UiTooltip>
        ) : null}
      </div>

      {suggestionsOpen ? (
        <div
          role="listbox"
          className="absolute left-0 right-0 top-full z-40 mt-1 max-h-[min(22rem,calc(100vh-5rem))] overflow-y-auto rounded-lg border border-border bg-background p-1 text-foreground shadow-lg"
        >
          {filteredModels.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No model found.</p>
          ) : (
            <div className="space-y-1">
              <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Models</p>
              {filteredModels.map((model, index) => (
                <button
                  key={model.id}
                  id={`model-search-option-${index}`}
                  type="button"
                  role="option"
                  aria-selected={activeSuggestionIndex === index}
                  className={cn(
                    "flex w-full cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors",
                    activeSuggestionIndex === index ? "bg-accent text-accent-foreground" : "hover:bg-accent hover:text-accent-foreground",
                  )}
                  onMouseEnter={() => setActiveSuggestionIndex(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    selectModel(model);
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs sm:text-sm">{model.id}</p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {model.providers.map((provider) => (
                        <UiBadge key={`${model.id}-${provider}`} variant="outline" className="text-[10px] font-normal">
                          {getProviderLabel(provider)}
                        </UiBadge>
                      ))}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
