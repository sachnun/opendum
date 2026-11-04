import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, type JSX } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import { compareText } from "@opendum/models/compare";
import { SORT_ORDER, anchorId } from "@opendum/models/ranking";
import { compareEntries } from "@opendum/models/sort";
import { dayKeys, emptyStats, hourKeys, LOOKBACK_HOURS, MODEL_STATS_DAYS, type ModelStats } from "@opendum/models/stats";
import { labelOf } from "@opendum/providers/provider-accounts";
import type { UsageData } from "@opendum/providers/contract";
import type { ModelListItem } from "~/lib/api-types";
import { api } from "~/api";
import { isAuditMode } from "~/lib/audit";
import { dataKeys } from "~/lib/data-keys";
import { invalidation } from "~/lib/invalidate";
import { useLiveEvent } from "~/lib/live-event";
import { createQuery } from "~/lib/query";
import { Routes } from "~/lib/routes";
import { decodeHash, settle } from "~/lib/settle";
import { costEntries, costPoints, type ModelCost } from "~/lib/model-cost";
import { DataNotice } from "~/components/common/DataNotice";
import { ModelFeatureBadges } from "~/components/model/ModelFeatureBadges";
import { ModelStatsPanel } from "~/components/model/ModelStatsPanel";
import { UiBadge } from "~/components/ui/UiBadge";
import { UiCard, UiCardContent, UiCardHeader } from "~/components/ui/UiCard";
import { UiIcon } from "~/components/ui/UiIcon";
import { UiMarquee } from "~/components/ui/UiMarquee";
import { UiSwitch } from "~/components/ui/UiSwitch";
import { UiTooltip } from "~/components/ui/UiTooltip";
import { asSpanProps } from "~/components/ui/trigger";

const STATS_BATCH_SIZE = 24;
const STATS_ROOT_MARGIN = "600px 0px";
const HIGHLIGHT_DURATION_MS = 2500;

export function ModelsPage(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();

  const modelsQuery = createQuery<ModelListItem[]>(dataKeys.models, () => api.models.list({ includeStats: false }));
  const models = () => modelsQuery.data() ?? [];

  const [statsById, setStatsById] = createSignal<Record<string, ModelStats>>({});
  const [pendingModelId, setPendingModelId] = createSignal<string | null>(null);
  const [copiedModelId, setCopiedModelId] = createSignal<string | null>(null);
  const [visibleModelIds, setVisibleModelIds] = createSignal(new Set<string>());
  const [highlightedModelId, setHighlightedModelId] = createSignal<string | null>(null);
  let modelsRoot: HTMLDivElement | undefined;
  let highlightTimer: ReturnType<typeof setTimeout> | null = null;
  let statsTimer: ReturnType<typeof setTimeout> | null = null;
  let statsObserver: IntersectionObserver | null = null;
  const queuedStatsIds = new Set<string>();
  const forceStatsIds = new Set<string>();
  const loadingStatsIds = new Set<string>();
  const intersectingModelIds = new Set<string>();

  const emptyModelStats = emptyStats(dayKeys(MODEL_STATS_DAYS), hourKeys(LOOKBACK_HOURS));

  function isLinked(model: ModelListItem) {
    return model.available !== false;
  }

  function isActive(model: ModelListItem) {
    return isLinked(model) && model.isEnabled;
  }

  const customModelIds = createMemo(() => new Set(models().filter((model) => model.custom).map((model) => model.id)));
  const enabledModelCount = () =>
    models().filter((model) => model.available !== false && model.isEnabled).length;

  const modelSections = createMemo(() => {
    const groupedModels = new Map<string, ModelListItem[]>();

    for (const model of models()) {
      const family = model.family && model.family.trim().length > 0 ? model.family : "Others";
      const familyModels = groupedModels.get(family) ?? [];
      familyModels.push(model);
      groupedModels.set(family, familyModels);
    }

    for (const familyModels of groupedModels.values()) familyModels.sort(compareEntries);

    const rankedFamilies = SORT_ORDER.filter((family) => family !== "Others");
    const rankedSet = new Set<string>(rankedFamilies);

    const sections = rankedFamilies
      .map((family) => ({ name: family, anchorId: anchorId(family), models: groupedModels.get(family) ?? [] }))
      .filter((section) => section.models.length > 0);

    const tailSections = [...groupedModels.keys()]
      .filter((family) => family !== "Others" && !rankedSet.has(family))
      .sort((a, b) => compareText(a, b))
      .map((family) => ({ name: family, anchorId: anchorId(family), models: groupedModels.get(family) ?? [] }));

    const otherModels = groupedModels.get("Others") ?? [];
    if (otherModels.length > 0) {
      tailSections.push({ name: "Others", anchorId: "other-models-misc", models: otherModels });
    }

    if (tailSections.length > 0) {
      const firstTail = tailSections[0];
      if (firstTail) sections.push({ ...firstTail, anchorId: "other-models" });
      sections.push(...tailSections.slice(1));
    }

    return sections;
  });

  function observeCards() {
    if (!statsObserver) return;
    const root = modelsRoot;
    if (!root) return;

    statsObserver.disconnect();
    intersectingModelIds.clear();

    for (const element of root.querySelectorAll<HTMLElement>("[data-model-id]")) {
      statsObserver.observe(element);
    }
  }

  function queueStats(modelIds: Iterable<string>, options: { force?: boolean } = {}) {
    for (const modelId of modelIds) {
      if (!options.force && statsById()[modelId]) continue;
      if (loadingStatsIds.has(modelId)) continue;
      queuedStatsIds.add(modelId);
      if (options.force) forceStatsIds.add(modelId);
    }

    if (queuedStatsIds.size === 0 || statsTimer) return;
    statsTimer = setTimeout(() => {
      statsTimer = null;
      void flushStats();
    }, 80);
  }

  async function flushStats() {
    const modelIds = Array.from(queuedStatsIds).slice(0, STATS_BATCH_SIZE);
    for (const modelId of modelIds) queuedStatsIds.delete(modelId);
    const force = modelIds.some((modelId) => forceStatsIds.has(modelId));
    for (const modelId of modelIds) forceStatsIds.delete(modelId);

    await loadStats(modelIds, { force });

    if (queuedStatsIds.size > 0) {
      statsTimer = setTimeout(() => {
        statsTimer = null;
        void flushStats();
      }, 80);
    }
  }

  async function loadStats(modelIds: string[], options: { force?: boolean } = {}) {
    const availableModelIds = new Set(models().filter((model) => model.available !== false).map((model) => model.id));
    const requestedModelIds = Array.from(new Set(modelIds))
      .filter((modelId) => availableModelIds.has(modelId) && !customModelIds().has(modelId))
      .filter((modelId) => !loadingStatsIds.has(modelId))
      .filter((modelId) => options.force || !statsById()[modelId]);

    if (requestedModelIds.length === 0) return;

    for (const modelId of requestedModelIds) loadingStatsIds.add(modelId);

    const loaded = await settle(() => api.models.stats({ models: requestedModelIds }));
    if (loaded.ok) {
      setStatsById((current) => ({ ...current, ...loaded.value }));
    }
    for (const modelId of requestedModelIds) loadingStatsIds.delete(modelId);
  }

  function applyUsage(data: UsageData) {
    setStatsById((current) => ({ ...current, ...data.modelStats }));
  }

  useLiveEvent("usage", applyUsage);

  function pruneStats() {
    const availableModelIds = new Set(models().filter((model) => model.available !== false).map((model) => model.id));

    setStatsById((current) =>
      Object.fromEntries(Object.entries(current).filter(([modelId]) => availableModelIds.has(modelId)))
    );
    for (const modelId of forceStatsIds) {
      if (!availableModelIds.has(modelId)) forceStatsIds.delete(modelId);
    }
    setVisibleModelIds((current) => new Set([...current].filter((modelId) => availableModelIds.has(modelId))));
    for (const modelId of intersectingModelIds) {
      if (!availableModelIds.has(modelId)) intersectingModelIds.delete(modelId);
    }
  }

  createEffect(
    on(models, () => {
      pruneStats();
      queueMicrotask(observeCards);
    })
  );

  createEffect(
    on(modelSections, () => {
      queueMicrotask(observeCards);
    })
  );

  async function copyId(modelId: string) {
    await navigator.clipboard.writeText(modelId);
    setCopiedModelId(modelId);
    window.setTimeout(() => {
      if (copiedModelId() === modelId) setCopiedModelId(null);
    }, 2000);
  }

  function applyEnabled(modelId: string, enabled: boolean) {
    const current = modelsQuery.data();
    if (!current) return;
    modelsQuery.setData(current.map((model) => (model.id === modelId ? { ...model, isEnabled: enabled } : model)));
  }

  function costSummary(cost: ModelCost) {
    return `${costPoints(cost.input ?? 0)}/${costPoints(cost.output ?? 0)}`;
  }

  async function enableModel(model: ModelListItem, enabled: boolean) {
    if (isAuditMode() || model.available === false) return;
    setPendingModelId(model.id);
    const previousValue = model.isEnabled;
    applyEnabled(model.id, enabled);

    const updated = await settle(() => api.models.setEnabled({ modelId: model.id, enabled }));
    setPendingModelId(null);
    if (updated.ok && updated.value.success) {
      invalidation.patchModelEnabled(updated.value.data.model, updated.value.data.enabled);
      void invalidation.invalidateModelAvailability();
    } else {
      applyEnabled(model.id, previousValue);
    }
  }

  function hashModel(hash: string): string | null {
    const raw = hash.startsWith("#") ? hash.slice(1) : hash;
    const id = raw.startsWith("model-") ? raw.slice("model-".length) : raw;
    if (!id) return null;
    return decodeHash(id);
  }

  createEffect(
    on(
      () => location.hash,
      (raw) => {
        const hashRaw = raw.startsWith("#") ? raw.slice(1) : raw;
        if (!hashRaw.startsWith("model-")) return;
        const id = hashModel(raw);
        if (!id) return;
        if (highlightedModelId() === id) return;

        setHighlightedModelId(id);
        if (highlightTimer) clearTimeout(highlightTimer);
        highlightTimer = setTimeout(() => {
          setHighlightedModelId(null);
          highlightTimer = null;
        }, HIGHLIGHT_DURATION_MS);

        if (location.pathname === Routes.models) {
          window.history.replaceState(window.history.state, "", Routes.models);
        }
      }
    )
  );

  onMount(() => {
    statsObserver = new IntersectionObserver(
      (entries) => {
        const visibleIds: string[] = [];

        for (const entry of entries) {
          const modelId = (entry.target as HTMLElement).dataset.modelId;
          if (!modelId) continue;

          if (!entry.isIntersecting) {
            intersectingModelIds.delete(modelId);
            continue;
          }

          setVisibleModelIds((current) => new Set(current).add(modelId));
          intersectingModelIds.add(modelId);
          visibleIds.push(modelId);
        }

        if (visibleIds.length > 0) queueStats(visibleIds);
      },
      { rootMargin: STATS_ROOT_MARGIN }
    );

    observeCards();
  });

  onCleanup(() => {
    statsObserver?.disconnect();
    statsObserver = null;
    if (statsTimer) clearTimeout(statsTimer);
    if (highlightTimer) clearTimeout(highlightTimer);
  });

  function openPlayground(modelId: string) {
    const params = new URLSearchParams({ model: modelId, compare: "auto" }).toString();
    navigate(`${Routes.playground}?${params}`);
  }

  return (
    <div ref={modelsRoot} class="space-y-6">
      <div class="web-header-divider">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-xl font-semibold">Models</h2>
          <UiBadge variant="outline">
            {enabledModelCount()}/{models().length}
          </UiBadge>
        </div>
      </div>

      <DataNotice error={modelsQuery.error()} />
      <Show when={models().length > 0}>
        <div class="space-y-6">
          <For each={modelSections()}>
            {(section) => (
              <section id={section.anchorId} class="scroll-mt-24 space-y-4 md:space-y-2">
                <div class="flex items-center gap-2">
                  <h3 class="text-sm font-semibold">{section.name}</h3>
                  <UiBadge variant="outline" class="text-[10px] font-normal">
                    {section.models.length} models
                  </UiBadge>
                </div>
                <div class="web-card-grid">
                  <For each={section.models}>
                    {(model) => (
                      <UiCard
                        id={`model-${model.id}`}
                        data-model-id={model.id}
                        class={`flex h-full flex-col scroll-mt-20 bg-transparent [contain-intrinsic-size:auto_12rem] [content-visibility:auto] transition-[border-color,box-shadow] duration-[1800ms] ease-out${
                          isLinked(model) ? (isActive(model) ? "" : " opacity-65") : " grayscale opacity-40"
                        }${
                          highlightedModelId() === model.id
                            ? " border-primary shadow-[0_0_0_3px_var(--primary)]"
                            : " border-border shadow-none"
                        }`}
                      >
                        <UiCardHeader class="pb-1">
                          <div class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
                            <button
                              type="button"
                              class={`-m-1 flex min-w-0 flex-1 items-center gap-1.5 rounded-md p-1 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                                isLinked(model) ? "cursor-pointer" : "cursor-default"
                              }`}
                              disabled={!isLinked(model)}
                              aria-label={`Copy model ID ${model.id}`}
                              onClick={() => void copyId(model.id)}
                            >
                              <span class="flex size-3 shrink-0 items-center justify-center">
                                <UiIcon
                                  name={copiedModelId() === model.id ? "i-lucide-check" : "i-lucide-copy"}
                                  class="size-3"
                                />
                              </span>
                              <UiMarquee text={model.id} class="flex-1 font-mono text-sm font-semibold leading-5" />
                            </button>
                            <div class="mt-0.5 flex shrink-0 items-center gap-1.5">
                              <Show
                                when={isLinked(model)}
                                fallback={
                                  <button
                                    type="button"
                                    class="inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                                    aria-label="Try in Playground"
                                    onClick={() => openPlayground(model.id)}
                                  >
                                    <UiIcon name="i-lucide-flask-conical" class="size-3" />
                                  </button>
                                }
                              >
                                <UiTooltip text="Playground">
                                  <button
                                    type="button"
                                    class="inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                                    aria-label="Try in Playground"
                                    onClick={() => openPlayground(model.id)}
                                  >
                                    <UiIcon name="i-lucide-flask-conical" class="size-3" />
                                  </button>
                                </UiTooltip>
                              </Show>
                              <span class="w-5 text-right text-[11px] leading-none text-muted-foreground">
                                {isActive(model) ? "On" : "Off"}
                              </span>
                              <UiSwitch
                                checked={isActive(model)}
                                disabled={!isLinked(model) || pendingModelId() === model.id || isAuditMode()}
                                title={isLinked(model) ? (model.isEnabled ? "Disable" : "Enable") : undefined}
                                onCheckedChange={(checked) => void enableModel(model, checked)}
                              />
                            </div>
                          </div>

                          <div class="mt-1 flex items-start justify-between gap-2">
                            <div class="flex min-w-0 flex-wrap items-center gap-1.5">
                              <For each={model.providers}>
                                {(provider) => (
                                  <UiBadge
                                    variant="outline"
                                    class={
                                      isLinked(model)
                                        ? "text-[10px] font-normal"
                                        : "text-[10px] font-normal border-border/60 text-muted-foreground opacity-70"
                                    }
                                  >
                                    {labelOf(provider)}
                                  </UiBadge>
                                )}
                              </For>
                            </div>
                            <Show when={model.cost}>
                              {(cost) => (
                                <UiTooltip
                                  side="left"
                                  trigger={(triggerProps) => (
                                    <span
                                      {...asSpanProps(triggerProps)}
                                      class="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] font-normal leading-none text-muted-foreground tabular-nums"
                                    >
                                      <UiIcon name="i-lucide-coins" class="size-3" />
                                      {costSummary(cost())}
                                    </span>
                                  )}
                                  content={
                                    <div class="space-y-0.5">
                                      <p class="font-medium">Cost in points per 1M tokens</p>
                                      <For each={costEntries(cost())}>
                                        {(entry) => (
                                          <p>
                                            {entry.label}: {costPoints(entry.value)}
                                          </p>
                                        )}
                                      </For>
                                    </div>
                                  }
                                />
                              )}
                            </Show>
                          </div>
                        </UiCardHeader>

                        <UiCardContent class="flex flex-1 flex-col pt-0">
                          <div class="mt-auto space-y-3">
                            <ModelFeatureBadges model={model} />
                            <Show
                              when={visibleModelIds().has(model.id)}
                              fallback={<div class="min-h-[7.75rem]" aria-hidden="true" />}
                            >
                              <ModelStatsPanel
                                stats={model.stats ?? emptyModelStats}
                                statsMap={statsById()}
                                modelId={model.id}
                                label={model.id}
                                disabled={!isActive(model)}
                                compact
                                animateDeltas={false}
                              />
                            </Show>
                          </div>
                        </UiCardContent>
                      </UiCard>
                    )}
                  </For>
                </div>
              </section>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

export default ModelsPage;
