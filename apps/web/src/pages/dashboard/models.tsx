import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { MODEL_FAMILY_SORT_ORDER, categorizeModelFamily } from "../../lib/model-families";
import { compareModelEntries } from "../../lib/model-sort";
import { buildDayKeys, buildEmptyModelStats, buildHourKeys, MODEL_DURATION_LOOKBACK_HOURS, MODEL_STATS_DAYS, type ModelStats } from "../../lib/model-stats";
import { getProviderLabel } from "../../lib/provider-accounts";
import type { ModelListItem } from "../../lib/dashboard-api-types";
import { useDashboardApi } from "../../hooks/useDashboardApi";
import { useDashboardAudit } from "../../hooks/useDashboardAudit";
import { dashboardDataKeys, useDashboardData } from "../../hooks/useDashboardDataInvalidation";
import { DashboardDataNotice } from "../../components/DashboardDataNotice";
import { ModelStatsPanel } from "../../components/ModelStatsPanel";
import { UiBadge } from "../../components/ui/UiBadge";
import { UiCard, UiCardContent, UiCardHeader } from "../../components/ui/UiCard";
import { UiIcon } from "../../components/ui/UiIcon";
import { UiSwitch } from "../../components/ui/UiSwitch";
import { UiTooltip } from "../../components/ui/UiTooltip";
import { cn } from "../../lib/utils";

const MODEL_STATS_BATCH_SIZE = 24;
const MODEL_STATS_POLL_MS = 30_000;
const HIGHLIGHT_DURATION_MS = 2500;

function getFamilyAnchorId(family: string) {
  const map: Record<string, string> = {
    OpenAI: "openai-models",
    Anthropic: "anthropic-models",
    Google: "google-models",
    Meta: "meta-models",
    Mistral: "mistral-models",
    Qwen: "qwen-models",
    DeepSeek: "deepseek-models",
    Moonshot: "moonshot-models",
    MiniMax: "minimax-models",
    Xiaomi: "xiaomi-models",
    xAI: "xai-models",
    "Z.AI": "zai-models",
    StepFun: "stepfun-models",
  };
  return map[family] ?? "other-models";
}

export function ModelFeatureBadges({ meta }: { meta?: ModelListItem["meta"] }) {
  const capabilities = meta;
  const reasoning = capabilities?.reasoning !== false;
  const toolCall = capabilities?.toolCall !== false;
  const vision = capabilities?.vision !== false;
  const hasAny = capabilities ? reasoning || toolCall || vision : false;
  if (!hasAny) return null;
  return (
    <div className="space-y-1.5 text-xs text-muted-foreground">
      <div className="flex flex-wrap gap-1">
        {reasoning ? (
          <UiBadge variant="outline" className="h-5 py-0 text-[11px]">
            <UiIcon name="i-lucide-brain" className="mr-1 size-3" /> Reasoning
          </UiBadge>
        ) : null}
        {toolCall ? (
          <UiBadge variant="outline" className="h-5 py-0 text-[11px]">
            <UiIcon name="i-lucide-wrench" className="mr-1 size-3" /> Tools
          </UiBadge>
        ) : null}
        {vision ? (
          <UiBadge variant="outline" className="h-5 py-0 text-[11px]">
            <UiIcon name="i-lucide-eye" className="mr-1 size-3" /> Vision
          </UiBadge>
        ) : null}
      </div>
    </div>
  );
}

export default function ModelsPage() {
  const location = useLocation();
  const dashboardApi = useDashboardApi();
  const { isAuditMode } = useDashboardAudit();
  const { data, error, refresh } = useDashboardData<ModelListItem[]>(dashboardDataKeys.models, () => dashboardApi.models.list({ includeStats: false }), { enabled: true });
  const models = data ?? [];
  const [modelStatsById, setModelStatsById] = useState<Record<string, ModelStats>>({});
  const [modelStatsCursorById, setModelStatsCursorById] = useState<Record<string, string>>({});
  const [activeProviders, setActiveProviders] = useState<string[]>([]);
  const [pendingModelId, setPendingModelId] = useState<string | null>(null);
  const [copiedModelId, setCopiedModelId] = useState<string | null>(null);
  const [highlightedModelId, setHighlightedModelId] = useState<string | null>(null);
  const queuedModelStatsIds = useRef(new Set<string>());
  const forceQueuedModelStatsIds = useRef(new Set<string>());
  const loadingModelStatsIds = useRef(new Set<string>());
  const modelStatsQueueTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modelsRef = useRef(models);
  modelsRef.current = models;

  const emptyModelStats = useMemo(() => buildEmptyModelStats(buildDayKeys(MODEL_STATS_DAYS), buildHourKeys(MODEL_DURATION_LOOKBACK_HOURS)), []);

  const availableProviders = useMemo(() => {
    const entries = new Map<string, string>();
    for (const model of models) {
      for (const provider of model.providers) entries.set(provider, getProviderLabel(provider));
    }
    return Array.from(entries, ([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [models]);

  useEffect(() => {
    if (activeProviders.length === 0 && availableProviders.length > 0) {
      setActiveProviders(availableProviders.map((provider) => provider.id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableProviders]);

  const allSelected = activeProviders.length === availableProviders.length;
  const filteredModels = useMemo(() => {
    const active = new Set(activeProviders);
    return models.filter((model) => model.providers.some((provider) => active.has(provider)));
  }, [models, activeProviders]);
  const enabledModelCount = models.filter((model) => model.isEnabled).length;

  const modelSections = useMemo(() => {
    const groupedModels = new Map<string, ModelListItem[]>();
    for (const model of filteredModels) {
      const family = categorizeModelFamily(model.family);
      const familyModels = groupedModels.get(family) ?? [];
      familyModels.push(model);
      groupedModels.set(family, familyModels);
    }
    for (const familyModels of groupedModels.values()) {
      familyModels.sort(compareModelEntries);
    }
    return MODEL_FAMILY_SORT_ORDER
      .map((family) => ({ name: family, anchorId: getFamilyAnchorId(family), models: groupedModels.get(family) ?? [] }))
      .filter((section) => section.models.length > 0);
  }, [filteredModels]);

  const loadModelStats = async (modelIds: string[], options: { force?: boolean } = {}) => {
    const availableModelIds = new Set(modelsRef.current.map((model) => model.id));
    const requestedModelIds = Array.from(new Set(modelIds))
      .filter((modelId) => availableModelIds.has(modelId))
      .filter((modelId) => !loadingModelStatsIds.current.has(modelId))
      .filter((modelId) => options.force || !modelStatsById[modelId]);
    if (requestedModelIds.length === 0) return;
    for (const modelId of requestedModelIds) loadingModelStatsIds.current.add(modelId);
    try {
      const response = await dashboardApi.models.stats({
        models: requestedModelIds,
        cursors: Object.fromEntries(requestedModelIds.map((modelId) => [modelId, modelStatsCursorById[modelId] ?? ""])),
      });
      setModelStatsCursorById((current) => ({ ...current, ...response.cursors }));
      if (response.stats) setModelStatsById((current) => ({ ...current, ...response.stats }));
    } catch (error) {
      console.error("Failed to load model stats:", error);
    } finally {
      for (const modelId of requestedModelIds) loadingModelStatsIds.current.delete(modelId);
    }
  };

  const queueModelStatsLoad = (modelIds: Iterable<string>, options: { force?: boolean } = {}) => {
    for (const modelId of modelIds) {
      if (!options.force && modelStatsById[modelId]) continue;
      if (loadingModelStatsIds.current.has(modelId)) continue;
      queuedModelStatsIds.current.add(modelId);
      if (options.force) forceQueuedModelStatsIds.current.add(modelId);
    }
    if (queuedModelStatsIds.current.size === 0 || modelStatsQueueTimer.current) return;
    modelStatsQueueTimer.current = setTimeout(() => {
      modelStatsQueueTimer.current = null;
      void (async () => {
        const modelIds = Array.from(queuedModelStatsIds.current).slice(0, MODEL_STATS_BATCH_SIZE);
        for (const modelId of modelIds) queuedModelStatsIds.current.delete(modelId);
        const force = modelIds.some((modelId) => forceQueuedModelStatsIds.current.has(modelId));
        for (const modelId of modelIds) forceQueuedModelStatsIds.current.delete(modelId);
        await loadModelStats(modelIds, { force });
        if (queuedModelStatsIds.current.size > 0) {
          modelStatsQueueTimer.current = setTimeout(() => {
            modelStatsQueueTimer.current = null;
            void (async () => {
              const next = Array.from(queuedModelStatsIds.current).slice(0, MODEL_STATS_BATCH_SIZE);
              for (const modelId of next) queuedModelStatsIds.current.delete(modelId);
              await loadModelStats(next, { force: next.some((id) => forceQueuedModelStatsIds.current.has(id)) });
            })();
          }, 80);
        }
      })();
    }, 80);
  };

  // Load stats on mount and poll
  useEffect(() => {
    queueModelStatsLoad(models.map((model) => model.id));
    const timer = setInterval(() => {
      if (document.hidden) return;
      queueModelStatsLoad(modelsRef.current.map((model) => model.id), { force: true });
    }, MODEL_STATS_POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Hash highlight
  useEffect(() => {
    const raw = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
    if (!raw.startsWith("model-")) return;
    let id = raw.slice("model-".length);
    try {
      id = decodeURIComponent(id);
    } catch {
      // keep
    }
    if (!id || highlightedModelId === id) return;
    setHighlightedModelId(id);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => {
      setHighlightedModelId(null);
      highlightTimer.current = null;
    }, HIGHLIGHT_DURATION_MS);
    window.history.replaceState(window.history.state, "", "/dashboard/models");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.hash]);

  const getModelStats = (model: ModelListItem): ModelStats => modelStatsById[model.id] ?? model.stats ?? emptyModelStats;

  const toggleProvider = (providerId: string) => {
    if (providerId === "all") {
      if (allSelected) {
        const first = availableProviders[0];
        setActiveProviders(first ? [first.id] : []);
      } else {
        setActiveProviders(availableProviders.map((provider) => provider.id));
      }
      return;
    }
    if (allSelected) {
      setActiveProviders([providerId]);
      return;
    }
    if (activeProviders.includes(providerId)) {
      const next = activeProviders.filter((id) => id !== providerId);
      if (next.length > 0) setActiveProviders(next);
      return;
    }
    setActiveProviders([...activeProviders, providerId]);
  };

  const copyModelId = async (modelId: string) => {
    await navigator.clipboard.writeText(modelId);
    setCopiedModelId(modelId);
    window.setTimeout(() => {
      if (copiedModelId === modelId) setCopiedModelId(null);
    }, 2000);
  };

  const setModelEnabled = async (model: ModelListItem, enabled: boolean) => {
    if (isAuditMode) return;
    setPendingModelId(model.id);
    const previousValue = model.isEnabled;
    if (data) {
      // optimistic patch handled by caller state
    }
    try {
      const result = await dashboardApi.models.setEnabled({ modelId: model.id, enabled });
      if (!result.success) throw new Error(result.error);
      await refresh();
    } catch (error) {
      console.error(error);
    } finally {
      setPendingModelId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="dashboard-header-divider">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold">Models</h2>
          <UiBadge variant="outline">{enabledModelCount}/{models.length}</UiBadge>
        </div>
      </div>

      <DashboardDataNotice error={error} />
      {models.length > 0 ? (
        <div className="space-y-4 md:space-y-2">
          <div className="flex flex-wrap gap-1.5 pb-2">
            <button
              type="button"
              className={cn(
                "inline-flex h-7 cursor-pointer items-center justify-center rounded-md border px-2.5 text-xs font-medium",
                allSelected ? "border-primary/35 bg-primary/10 text-primary" : "border-border/70 bg-card/30 text-muted-foreground",
              )}
              onClick={() => toggleProvider("all")}
            >
              All
            </button>
            {availableProviders.map((provider) => (
              <button
                key={provider.id}
                type="button"
                className={cn(
                  "inline-flex h-7 cursor-pointer items-center justify-center rounded-md border px-2.5 text-xs font-medium",
                  activeProviders.includes(provider.id) ? "border-primary/35 bg-primary/10 text-primary" : "border-border/70 bg-card/30 text-muted-foreground",
                )}
                onClick={() => toggleProvider(provider.id)}
              >
                {provider.label}
              </button>
            ))}
          </div>

          <div className="space-y-6">
            {modelSections.map((section) => (
              <section key={section.name} id={section.anchorId} className="scroll-mt-24 space-y-4 md:space-y-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold">{section.name}</h3>
                  <UiBadge variant="outline" className="text-[10px] font-normal">{section.models.length} models</UiBadge>
                </div>
                <div className="dashboard-card-grid">
                  {section.models.map((model) => (
                    <UiCard
                      key={model.id}
                      id={`model-${model.id}`}
                      data-model-id={model.id}
                      className={cn(
                        "flex h-full flex-col scroll-mt-20 bg-transparent transition-[border-color,box-shadow] duration-[1800ms] ease-out",
                        model.isEnabled === false && "opacity-65",
                        highlightedModelId === model.id ? "border-primary shadow-[0_0_0_3px_var(--primary)]" : "border-border shadow-none",
                      )}
                    >
                      <UiCardHeader className="pb-1">
                        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
                          <UiTooltip text="Copy ID">
                            <button
                              type="button"
                              className="-m-1 flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md p-1 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              aria-label={`Copy model ID ${model.id}`}
                              onClick={() => void copyModelId(model.id)}
                            >
                              <span className="flex size-3 shrink-0 items-center justify-center">
                                <UiIcon name={copiedModelId === model.id ? "i-lucide-check" : "i-lucide-copy"} className="size-3" />
                              </span>
                              <span className="min-w-0 flex-1 overflow-hidden break-all font-mono text-sm font-semibold leading-5 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
                                {model.id}
                              </span>
                            </button>
                          </UiTooltip>
                          <div className="mt-0.5 flex shrink-0 items-center gap-1.5">
                            {model.isEnabled ? (
                              <UiTooltip text="Playground">
                                <Link to={`/dashboard/playground?model=${encodeURIComponent(model.id)}&compare=auto`} className="inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground" aria-label="Try in Playground">
                                  <UiIcon name="i-lucide-flask-conical" className="size-3" />
                                </Link>
                              </UiTooltip>
                            ) : null}
                            <span className="w-5 text-right text-[11px] leading-none text-muted-foreground">{model.isEnabled ? "On" : "Off"}</span>
                            <UiSwitch
                              checked={model.isEnabled}
                              disabled={pendingModelId === model.id || isAuditMode}
                              title={model.isEnabled ? "Disable" : "Enable"}
                              onCheckedChange={(value) => void setModelEnabled(model, value)}
                            />
                          </div>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          {model.providers.map((provider) => (
                            <UiBadge
                              key={provider}
                              variant="outline"
                              className={cn("text-[10px] font-normal", activeProviders.includes(provider) ? "" : "border-border/60 text-muted-foreground opacity-70")}
                            >
                              {getProviderLabel(provider)}
                            </UiBadge>
                          ))}
                        </div>
                      </UiCardHeader>
                      <UiCardContent className="flex flex-1 flex-col pt-0">
                        <div className="mt-auto space-y-3">
                          <ModelFeatureBadges meta={model.meta} />
                          <ModelStatsPanel stats={getModelStats(model)} label={model.id} disabled={!model.isEnabled} compact animateDeltas={false} />
                        </div>
                      </UiCardContent>
                    </UiCard>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
