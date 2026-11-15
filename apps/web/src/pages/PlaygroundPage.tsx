import { For, Show, createEffect, on, type JSX } from "solid-js";
import { useLocation, useSearchParams } from "@solidjs/router";
import { labelOf } from "@opendum/providers/provider-accounts";
import { DataNotice } from "~/components/common/DataNotice";
import { UiBadge } from "~/components/ui/UiBadge";
import { UiButton } from "~/components/ui/UiButton";
import { UiCard, UiCardContent, UiCardHeader } from "~/components/ui/UiCard";
import { UiDialog } from "~/components/ui/UiDialog";
import { UiIcon } from "~/components/ui/UiIcon";
import { UiPopover } from "~/components/ui/UiPopover";
import { UiSheet } from "~/components/ui/UiSheet";
import { UiSwitch } from "~/components/ui/UiSwitch";
import { UiTooltip } from "~/components/ui/UiTooltip";
import { createPlayground, type PlaygroundQuery } from "~/lib/playground";
import { asButtonProps } from "~/components/ui/trigger";

export function PlaygroundPage(): JSX.Element {
  const location = useLocation();
  const [searchParams] = useSearchParams();

  const query = (): PlaygroundQuery => searchParams as PlaygroundQuery;
  const playground = createPlayground(query);

  createEffect(() => {
    playground.initializeFromRoute();
  });

  createEffect(
    on(
      () => location.search,
      () => playground.syncRoute(query())
    )
  );

  createEffect(() => {
    playground.pruneUnavailablePanels();
  });

  createEffect(() => {
    playground.syncLiveTimer();
  });

  createEffect(() => {
    const options = playground.options();
    if (options && !options.hasAnyProviderAccount) {
      window.location.assign("/");
    }
  });

  return (
    <div>
      <UiDialog
        open={playground.loopDialogOpen()}
        onOpenChange={playground.setLoopDialogOpen}
        ui={{ content: "sm:max-w-[400px]" }}
        content={
          <>
            <div class="space-y-1.5 pr-6">
              <h2 class="text-lg font-semibold">Run Loop</h2>
              <p class="text-sm text-muted-foreground">Choose how many times to run the selected playground scenario.</p>
            </div>
            <label class="grid gap-2 text-sm font-medium">
              Loop count
              <input
                value={playground.loopCountInput()}
                type="number"
                inputmode="numeric"
                min="1"
                step="1"
                class="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                onInput={(event) => playground.setLoopCountInput(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    playground.runLoop();
                  }
                }}
              />
            </label>
            <div class="flex justify-end gap-2">
              <UiButton variant="outline" size="sm" onClick={() => playground.setLoopDialogOpen(false)}>
                Cancel
              </UiButton>
              <UiButton size="sm" disabled={!playground.loopCountValid()} onClick={playground.runLoop}>
                Run loop
              </UiButton>
            </div>
          </>
        }
      />

      <UiSheet
        open={playground.settingsOpen()}
        onOpenChange={playground.setSettingsOpen}
        side="right"
        ui={{ content: "w-[88vw] max-w-sm overflow-y-auto p-0" }}
        content={
          <div class="flex min-h-full flex-col">
            <div class="border-b border-border px-5 py-4">
              <h2 class="text-lg font-semibold">Settings</h2>
            </div>
            <div class="flex-1 space-y-6 px-5 py-5">
              <section class="space-y-4">
                <h3 class="text-sm font-medium uppercase tracking-wide text-muted-foreground">Endpoint</h3>
                <div class="space-y-2">
                  <p class="text-sm font-medium">API Endpoint</p>
                  <For each={playground.ENDPOINT_OPTIONS}>
                    {(option) => (
                      <button
                        type="button"
                        class={`flex h-auto w-full cursor-pointer flex-col items-start justify-start rounded-md border px-3 py-2 text-left text-sm disabled:cursor-default disabled:pointer-events-none disabled:opacity-50 ${
                          playground.settings.endpoint === option.value
                            ? "border-primary/35 bg-primary/10 text-primary"
                            : "border-border/70 bg-card/30 text-muted-foreground"
                        }`}
                        disabled={playground.isAnyLoading()}
                        onClick={() => playground.setSettings("endpoint", option.value)}
                      >
                        <span class="text-xs font-medium">{option.label}</span>
                        <span
                          class={
                            playground.settings.endpoint === option.value
                              ? "text-[11px] text-primary/80"
                              : "text-[11px] text-muted-foreground"
                          }
                        >
                          {option.description}
                        </span>
                      </button>
                    )}
                  </For>
                  <p class="text-xs text-muted-foreground">Pick the API style you want to test in Playground.</p>
                </div>
              </section>

              <div class="h-px bg-border" />

              <section class="space-y-4">
                <h3 class="text-sm font-medium uppercase tracking-wide text-muted-foreground">Generation</h3>
                <div class="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
                  <div class="space-y-1">
                    <p class="text-sm font-medium">Stream Responses</p>
                    <p class="text-xs text-muted-foreground">Show tokens in real-time as they arrive</p>
                  </div>
                  <UiSwitch
                    checked={playground.settings.streamResponses}
                    disabled={playground.isAnyLoading()}
                    onCheckedChange={(checked) => playground.setSettings("streamResponses", checked)}
                  />
                </div>
                <label class="grid gap-2 text-sm font-medium">
                  <span class="flex items-center justify-between">
                    <span>Temperature</span>
                    <span class="w-12 text-right text-sm text-muted-foreground">
                      {playground.settings.temperature.toFixed(1)}
                    </span>
                  </span>
                  <input
                    value={playground.settings.temperature}
                    type="range"
                    min="0"
                    max="2"
                    step="0.1"
                    disabled={playground.isAnyLoading()}
                    class="w-full accent-primary"
                    onInput={(event) => playground.setSettings("temperature", Number(event.currentTarget.value))}
                  />
                  <span class="text-xs font-normal text-muted-foreground">
                    Higher values make output more creative and random
                  </span>
                </label>
                <label class="grid gap-2 text-sm font-medium">
                  <span class="flex items-center justify-between">
                    <span>Top P</span>
                    <span class="w-12 text-right text-sm text-muted-foreground">{playground.settings.topP.toFixed(2)}</span>
                  </span>
                  <input
                    value={playground.settings.topP}
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    disabled={playground.isAnyLoading() || playground.topPDeprecated()}
                    class="w-full accent-primary"
                    onInput={(event) => playground.setSettings("topP", Number(event.currentTarget.value))}
                  />
                  <Show
                    when={playground.topPDeprecated()}
                    fallback={
                      <span class="text-xs font-normal text-muted-foreground">
                        Nucleus sampling threshold (1.0 = consider all tokens)
                      </span>
                    }
                  >
                    <span class="text-xs font-normal text-amber-600 dark:text-amber-400">
                      This model's provider no longer accepts top_p; using default value (1.0)
                    </span>
                  </Show>
                </label>
                <label class="grid gap-2 text-sm font-medium">
                  Max Tokens
                  <input
                    value={playground.settings.maxTokens}
                    type="number"
                    min="1"
                    max="128000"
                    disabled={playground.isAnyLoading()}
                    class="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    onInput={(event) => playground.setSettings("maxTokens", Number(event.currentTarget.value))}
                  />
                  <span class="text-xs font-normal text-muted-foreground">Maximum number of tokens to generate</span>
                </label>
              </section>

              <div class="h-px bg-border" />

              <section class="space-y-4">
                <h3 class="text-sm font-medium uppercase tracking-wide text-muted-foreground">Additional Parameters</h3>
                <label class="grid gap-2 text-sm font-medium">
                  Request body JSON
                  <textarea
                    value={playground.additionalParametersInput()}
                    rows="8"
                    spellcheck={false}
                    placeholder={'{\n  "seed": 1234,\n  "metadata": { "case": "repro" }\n}'}
                    disabled={playground.isAnyLoading()}
                    class={`min-h-40 resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-50 ${
                      playground.additionalParametersError()
                        ? "border-destructive focus-visible:border-destructive focus-visible:ring-destructive/30"
                        : ""
                    }`}
                    onInput={(event) => playground.setAdditionalParametersInput(event.currentTarget.value)}
                  />
                  <span class="text-xs font-normal text-muted-foreground">
                    Merged into the final request body after the selected scenario and settings. Values here can override
                    generated fields.
                  </span>
                  <Show when={playground.additionalParametersError()}>
                    <span class="text-xs font-normal text-destructive">{playground.additionalParametersError()}</span>
                  </Show>
                </label>
              </section>

              <div class="h-px bg-border" />

              <section class="space-y-4">
                <h3 class="text-sm font-medium uppercase tracking-wide text-muted-foreground">Penalties</h3>
                <label class="grid gap-2 text-sm font-medium">
                  <span class="flex items-center justify-between">
                    <span>Presence Penalty</span>
                    <span class="w-12 text-right text-sm text-muted-foreground">
                      {playground.settings.presencePenalty.toFixed(1)}
                    </span>
                  </span>
                  <input
                    value={playground.settings.presencePenalty}
                    type="range"
                    min="-2"
                    max="2"
                    step="0.1"
                    disabled={playground.isAnyLoading()}
                    class="w-full accent-primary"
                    onInput={(event) => playground.setSettings("presencePenalty", Number(event.currentTarget.value))}
                  />
                  <span class="text-xs font-normal text-muted-foreground">
                    Penalize tokens based on whether they appear in the text so far
                  </span>
                </label>
                <label class="grid gap-2 text-sm font-medium">
                  <span class="flex items-center justify-between">
                    <span>Frequency Penalty</span>
                    <span class="w-12 text-right text-sm text-muted-foreground">
                      {playground.settings.frequencyPenalty.toFixed(1)}
                    </span>
                  </span>
                  <input
                    value={playground.settings.frequencyPenalty}
                    type="range"
                    min="-2"
                    max="2"
                    step="0.1"
                    disabled={playground.isAnyLoading()}
                    class="w-full accent-primary"
                    onInput={(event) => playground.setSettings("frequencyPenalty", Number(event.currentTarget.value))}
                  />
                  <span class="text-xs font-normal text-muted-foreground">
                    Penalize tokens based on how frequently they appear
                  </span>
                </label>
              </section>

              <div class="h-px bg-border" />

              <section class="space-y-4">
                <h3 class="text-sm font-medium uppercase tracking-wide text-muted-foreground">Reasoning</h3>
                <div class="space-y-2">
                  <p class="text-sm font-medium">Reasoning Effort</p>
                  <div class="flex gap-1 overflow-x-auto">
                    <For each={playground.REASONING_OPTIONS}>
                      {(option) => (
                        <UiButton
                          size="sm"
                          variant="outline"
                          class={`flex-1 border-border/70 bg-card/30 text-muted-foreground shadow-none hover:bg-card/30 ${
                            playground.settings.reasoningEffort === option.value
                              ? option.value === "none"
                                ? "border-primary/35 bg-primary/10 text-primary hover:bg-primary/10"
                                : "border-amber-500/35 bg-amber-500/10 text-amber-200 hover:bg-amber-500/10"
                              : ""
                          }`}
                          disabled={playground.isAnyLoading()}
                          onClick={() => playground.setSettings("reasoningEffort", option.value)}
                        >
                          {option.label}
                        </UiButton>
                      )}
                    </For>
                  </div>
                  <p class="text-xs text-muted-foreground">Enable extended thinking for reasoning models.</p>
                </div>
              </section>
            </div>
            <div class="border-t border-border p-5">
              <UiButton variant="outline" class="w-full" disabled={playground.isAnyLoading()} onClick={playground.resetSettings}>
                <UiIcon name="i-lucide-rotate-ccw" class="size-4" />
                Reset to Defaults
              </UiButton>
            </div>
          </div>
        }
      />

      <div class="space-y-6">
        <div class="web-header-divider">
          <div class="flex items-center justify-between gap-4">
            <h1 class="text-xl font-semibold">Playground</h1>
            <div class="flex items-center gap-2">
              <Show when={playground.isAnyLoading()}>
                <UiButton type="button" variant="outline" size="sm" onClick={playground.stopAll}>
                  <span class="relative inline-flex">
                    <UiIcon name="i-lucide-square" class="size-3.5" />
                    <Show when={playground.loopBadge()}>
                      {(badge) => (
                        <span class="absolute -right-3 -top-2 rounded-full bg-primary px-1 py-0.5 text-[9px] font-semibold leading-none text-primary-foreground">
                          {badge()}
                        </span>
                      )}
                    </Show>
                  </span>
                  Stop all
                </UiButton>
              </Show>
              <UiButton
                type="button"
                variant="outline"
                size="sm"
                class="select-none"
                disabled={!playground.canRunPlayground()}
                onClick={playground.onTap}
                onPointerDown={playground.onPress}
                onPointerUp={playground.pressRelease}
                onPointerLeave={playground.pressRelease}
                onPointerCancel={playground.pressRelease}
                onSelectStart={(event) => event.preventDefault()}
                onDragStart={(event) => event.preventDefault()}
                onContextMenu={(event) => event.preventDefault()}
              >
                <UiIcon name="i-lucide-play" class="size-4" />
                Start
              </UiButton>
              <UiTooltip text="Settings">
                <UiButton
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label="Settings"
                  onClick={() => playground.setSettingsOpen(true)}
                >
                  <UiIcon name="i-lucide-settings" class="size-4" />
                </UiButton>
              </UiTooltip>
            </div>
          </div>
        </div>

        <DataNotice error={playground.optionsQuery.error()} />

        <div class="space-y-3">
          <h2 class="text-sm font-medium text-muted-foreground">Scenario</h2>
          <div class="flex flex-wrap gap-2">
            <For each={playground.SCENARIOS}>
              {(scenario) => (
                <button
                  type="button"
                  disabled={playground.isAnyLoading()}
                  class={`flex h-auto min-w-[72px] cursor-pointer flex-col items-center gap-1 rounded-md border px-3 py-2 text-sm font-medium disabled:cursor-default disabled:pointer-events-none disabled:opacity-50 ${
                    playground.selectedScenario().id === scenario.id
                      ? scenario.isReasoning
                        ? "border-amber-500/35 bg-amber-500/10 text-amber-200"
                        : "border-primary/35 bg-primary/10 text-primary"
                      : scenario.isReasoning
                        ? "border-dashed border-amber-500/25 bg-card/30 text-muted-foreground"
                        : "border-border/70 bg-card/30 text-muted-foreground"
                  }`}
                  onClick={() => playground.selectScenario(scenario)}
                >
                  <UiIcon name={scenario.icon} class="size-4" />
                  <span class="text-xs">{scenario.name}</span>
                </button>
              )}
            </For>
          </div>
        </div>

        <div class="space-y-3">
          <button
            type="button"
            class="flex w-full cursor-pointer items-center justify-between gap-3 text-left"
            aria-expanded={playground.familyPresetExpanded()}
            onClick={() => playground.setFamilyPresetExpanded(!playground.familyPresetExpanded())}
          >
            <span class="text-sm font-medium text-muted-foreground">Family Preset</span>
            <span class="flex items-center gap-2 text-xs text-muted-foreground">
              {playground.familyPresets().length} groups
              <UiIcon
                name={playground.familyPresetExpanded() ? "i-lucide-chevron-up" : "i-lucide-chevron-down"}
                class="size-4"
              />
            </span>
          </button>
          <Show when={playground.familyPresetExpanded() && playground.familyPresets().length > 0}>
            <div class="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap">
              <For each={playground.familyPresets()}>
                {(preset) => (
                  <button
                    type="button"
                    disabled={playground.isAnyLoading()}
                    class={`flex h-auto w-full min-w-0 cursor-pointer flex-col items-center gap-0.5 rounded-md border px-3 py-2 text-center text-sm font-medium disabled:cursor-default disabled:pointer-events-none disabled:opacity-50 sm:w-auto sm:min-w-[92px] ${
                      playground.activeFamilyPresets().includes(preset.family)
                        ? "border-primary/35 bg-primary/10 text-primary"
                        : "border-border/70 bg-card/30 text-muted-foreground"
                    }`}
                    onClick={() => playground.toggleFamily(preset.family)}
                  >
                    <span class="whitespace-normal break-words text-xs leading-tight">{preset.family}</span>
                    <span
                      class={
                        playground.activeFamilyPresets().includes(preset.family)
                          ? "text-[10px] leading-none text-primary/80"
                          : "text-[10px] leading-none text-muted-foreground"
                      }
                    >
                      {preset.models.length} models
                    </span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>

        <div class="space-y-3">
          <button
            type="button"
            class="flex w-full cursor-pointer items-center justify-between gap-3 text-left"
            aria-expanded={playground.providerPresetExpanded()}
            onClick={() => playground.setProviderPresetExpanded(!playground.providerPresetExpanded())}
          >
            <span class="text-sm font-medium text-muted-foreground">Provider Preset</span>
            <span class="flex items-center gap-2 text-xs text-muted-foreground">
              {playground.providerPresets().length} providers
              <UiIcon
                name={playground.providerPresetExpanded() ? "i-lucide-chevron-up" : "i-lucide-chevron-down"}
                class="size-4"
              />
            </span>
          </button>
          <Show when={playground.providerPresetExpanded() && playground.providerPresets().length > 0}>
            <div class="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap">
              <For each={playground.providerPresets()}>
                {(preset) => (
                  <button
                    type="button"
                    disabled={playground.isAnyLoading()}
                    class={`flex h-auto min-h-10 w-full min-w-0 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-md border px-3 py-2 text-center text-sm font-medium disabled:cursor-default disabled:pointer-events-none disabled:opacity-50 sm:w-auto sm:min-w-[92px] ${
                      playground.activeProviderPresets().includes(preset.provider)
                        ? "border-primary/35 bg-primary/10 text-primary"
                        : "border-border/70 bg-card/30 text-muted-foreground"
                    }`}
                    onClick={() => playground.toggleProvider(preset.provider)}
                  >
                    <span class="whitespace-normal break-words text-xs leading-tight">{labelOf(preset.provider)}</span>
                    <Show when={playground.presetLabel(preset.accounts)}>
                      {(presetText) => (
                        <span
                          class={
                            playground.activeProviderPresets().includes(preset.provider)
                              ? "text-[10px] leading-none text-primary/80"
                              : "text-[10px] leading-none text-muted-foreground"
                          }
                        >
                          {presetText()}
                        </span>
                      )}
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>

        <div class="web-card-grid">
          <For each={playground.panels()}>
            {(panel) => (
              <UiCard class="relative flex h-[400px] flex-col gap-0 overflow-hidden border-border/70 bg-card/40 py-0 shadow-none">
                <Show when={playground.panels().length > 1}>
                  <UiTooltip text="Remove">
                    <UiButton
                      variant="ghost"
                      size="icon-xs"
                      class="absolute right-2 top-2 z-10 h-7 w-7 rounded-full bg-transparent p-0 text-muted-foreground"
                      aria-label="Remove comparison card"
                      onClick={() => playground.removePanel(panel.id)}
                    >
                      <UiIcon name="i-lucide-x" class="size-3.5" />
                    </UiButton>
                  </UiTooltip>
                </Show>

                <UiCardHeader
                  class={`flex-none gap-0 bg-muted/10 py-2 pl-3 ${playground.panels().length > 1 ? "pr-11" : "pr-3"}`}
                >
                  <UiPopover
                    open={playground.pickerOpen[panel.id] ?? false}
                    onOpenChange={(open) => (open ? playground.openPicker(panel) : playground.setPickerOpen(panel.id, false))}
                    align="start"
                    contentClass="w-[340px] max-w-[calc(100vw-2rem)] p-0"
                    trigger={(triggerProps) => (
                      <UiButton
                        {...asButtonProps(triggerProps)}
                        type="button"
                        variant="ghost"
                        class="h-8 flex-1 justify-between bg-transparent px-0 font-normal shadow-none"
                        disabled={playground.responses()[panel.id]?.isLoading}
                      >
                        <Show
                          when={panel.modelId ? playground.modelsById().get(panel.modelId) : undefined}
                          fallback={<span class="text-muted-foreground">Select model...</span>}
                        >
                          {(model) => (
                            <span class="flex min-w-0 items-center gap-2">
                              <Show when={playground.visionWarning(model())}>
                                <UiTooltip text="This model may not support vision input">
                                  <UiIcon name="i-lucide-triangle-alert" class="size-3.5 shrink-0 text-yellow-500" />
                                </UiTooltip>
                              </Show>
                              <span class="truncate">{model().name}</span>
                              <UiBadge
                                variant="secondary"
                                class="shrink-0 whitespace-nowrap bg-muted/40 px-1.5 py-0 text-[10px] text-muted-foreground"
                              >
                                {playground.routeAccount(panel)
                                  ? labelOf(playground.accountsById().get(playground.routeAccount(panel) as string)?.provider ?? "")
                                  : playground.responses()[panel.id]?.usedAccountId
                                    ? `Auto - ${labelOf(playground.accountsById().get(playground.responses()[panel.id]?.usedAccountId ?? "")?.provider ?? "")}`
                                    : playground.panelProvider(panel)
                                      ? playground.scopedLabel(playground.panelProvider(panel) as string)
                                      : "Auto"}
                              </UiBadge>
                            </span>
                          )}
                        </Show>
                        <UiIcon name="i-lucide-chevron-down" class="ml-1 size-3 shrink-0 opacity-50" />
                      </UiButton>
                    )}
                    content={
                      <Show
                        when={playground.pickerStep[panel.id] === "routing"}
                        fallback={
                          <div class="max-h-[420px] overflow-hidden">
                            <div class="border-b p-2">
                              <input
                                value={playground.modelSearch[panel.id] ?? ""}
                                placeholder="Search models..."
                                class="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none"
                                onInput={(event) => playground.searchModels(panel.id, event)}
                              />
                            </div>
                            <div class="max-h-[360px] overflow-y-auto p-1">
                              <Show
                                when={playground.groupedModels(panel).length > 0}
                                fallback={
                                  <p class="px-2 py-6 text-center text-sm text-muted-foreground">No model found.</p>
                                }
                              >
                                <For each={playground.groupedModels(panel)}>
                                  {(group) => (
                                    <div class="py-1">
                                      <p class="px-2 py-1.5 text-[11px] font-semibold text-muted-foreground">
                                        {group.family}
                                      </p>
                                      <For each={group.models}>
                                        {(model) => (
                                          <button
                                            type="button"
                                            class={`flex w-full cursor-pointer items-start gap-2 rounded-sm px-2 py-2 text-left hover:bg-accent hover:text-accent-foreground ${
                                              panel.modelId === model.id ? "bg-accent" : ""
                                            }`}
                                            onClick={() => playground.selectModel(panel, model.id)}
                                          >
                                            <div class="min-w-0 flex-1">
                                              <p class="truncate text-xs font-medium">{model.name}</p>
                                              <div class="mt-1 flex flex-wrap gap-1">
                                                <For each={model.providers}>
                                                  {(provider) => (
                                                    <UiBadge variant="outline" class="h-4 px-1.5 text-[9px]">
                                                      {labelOf(provider)}
                                                    </UiBadge>
                                                  )}
                                                </For>
                                              </div>
                                            </div>
                                          </button>
                                        )}
                                      </For>
                                    </div>
                                  )}
                                </For>
                              </Show>
                            </div>
                          </div>
                        }
                      >
                        <div class="max-h-[420px] overflow-hidden">
                          <div class="flex items-center justify-between border-b px-2 py-1.5">
                            <UiButton
                              type="button"
                              variant="ghost"
                              size="sm"
                              class="h-7 gap-1 px-2 text-xs"
                              onClick={() => {
                                playground.setPickerStep(panel.id, "model");
                                playground.setPendingModel(panel.id, null);
                              }}
                            >
                              <UiIcon name="i-lucide-chevron-left" class="size-3.5" />
                              Models
                            </UiButton>
                            <p class="max-w-[220px] truncate text-xs font-medium">{playground.pendingModel[panel.id]}</p>
                          </div>
                          <div class="border-b p-2">
                            <input
                              value={playground.routeSearch[panel.id] ?? ""}
                              placeholder="Search provider or account..."
                              class="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none"
                              onInput={(event) => playground.searchRoutes(panel.id, event)}
                            />
                          </div>
                          <div class="max-h-[330px] overflow-y-auto p-1">
                            <p class="px-2 py-1.5 text-[11px] font-semibold text-muted-foreground">Routing</p>
                            <button
                              type="button"
                              class={`flex w-full cursor-pointer items-center rounded-sm px-2 py-2 text-left hover:bg-accent hover:text-accent-foreground ${
                                panel.modelId === playground.pendingModel[panel.id] && !panel.provider && !panel.accountId
                                  ? "bg-accent"
                                  : ""
                              }`}
                              onClick={() => playground.selectRoute(panel, { provider: null, accountId: null })}
                            >
                              <div class="min-w-0 flex-1">
                                <p class="truncate text-xs font-medium">Auto (load balancer)</p>
                                <p class="truncate text-[10px] text-muted-foreground">
                                  System chooses best provider account
                                </p>
                              </div>
                            </button>
                            <For each={playground.pendingProviders(panel)}>
                              {(provider) => (
                                <button
                                  type="button"
                                  class={`flex w-full cursor-pointer items-center rounded-sm px-2 py-2 text-left hover:bg-accent hover:text-accent-foreground ${
                                    panel.modelId === playground.pendingModel[panel.id] && panel.provider === provider && !panel.accountId
                                      ? "bg-accent"
                                      : ""
                                  }`}
                                  onClick={() => playground.selectRoute(panel, { provider, accountId: null })}
                                >
                                  <div class="min-w-0 flex-1">
                                    <p class="truncate text-xs font-medium">{playground.scopedLabel(provider)}</p>
                                    <p class="truncate text-[10px] text-muted-foreground">
                                      Load balance within {labelOf(provider)}
                                    </p>
                                  </div>
                                  <UiBadge variant="outline" class="ml-2 shrink-0 text-[10px]">
                                    {labelOf(provider)}
                                  </UiBadge>
                                </button>
                              )}
                            </For>
                            <For each={playground.pendingAccounts(panel)}>
                              {(account) => (
                                <button
                                  type="button"
                                  class={`flex w-full cursor-pointer items-center rounded-sm px-2 py-2 text-left hover:bg-accent hover:text-accent-foreground ${
                                    panel.modelId === playground.pendingModel[panel.id] && panel.accountId === account.id
                                      ? "bg-accent"
                                      : ""
                                  }`}
                                  onClick={() => playground.selectRoute(panel, { provider: null, accountId: account.id })}
                                >
                                  <div class="min-w-0 flex-1">
                                    <p class="truncate text-xs font-medium">{playground.accountLabel(account)}</p>
                                    <p class="truncate text-[10px] text-muted-foreground">{labelOf(account.provider)}</p>
                                  </div>
                                  <div class="ml-2 flex shrink-0 items-center gap-1">
                                    <Show when={playground.accountStatus(account)}>
                                      {(status) => (
                                        <UiBadge variant="secondary" class="text-[10px]">
                                          {status()}
                                        </UiBadge>
                                      )}
                                    </Show>
                                    <UiBadge variant="outline" class="text-[10px]">
                                      {labelOf(account.provider)}
                                    </UiBadge>
                                  </div>
                                </button>
                              )}
                            </For>
                          </div>
                        </div>
                      </Show>
                    }
                  />
                </UiCardHeader>

                <UiCardContent class="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
                  <div
                    ref={(element) => playground.bindScroll(panel.id, element)}
                    class="min-h-0 flex-1 overflow-y-auto bg-background/20 p-3"
                    onScroll={(event) => playground.onScroll(panel.id, event)}
                  >
                    <Show when={playground.conversationMessages(panel.id).length > 0}>
                      <Show when={playground.systemPrompt(panel.id)}>
                        <pre class="mb-2 whitespace-pre-wrap font-sans text-[11px] leading-relaxed text-muted-foreground">
                          {playground.systemPrompt(panel.id)}
                        </pre>
                      </Show>

                      <For each={playground.userMessages(panel.id)}>
                        {(message) => (
                          <div class="mb-2 flex gap-2">
                            <div
                              class={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full ${
                                message.role === "assistant" ? "bg-secondary/80" : "bg-primary/10"
                              }`}
                            >
                              <UiIcon
                                name={message.role === "assistant" ? "i-lucide-bot" : "i-lucide-user"}
                                class={`size-3 ${message.role === "assistant" ? "text-secondary-foreground" : "text-primary"}`}
                              />
                            </div>
                            <div class="min-w-0 flex-1">
                              <p
                                class={`mb-1 text-[11px] font-medium ${
                                  message.role === "assistant" ? "text-muted-foreground" : "text-primary"
                                }`}
                              >
                                {message.role === "assistant" ? "Assistant" : "User"}
                              </p>
                              <div
                                class={`rounded-lg px-3 py-2 ${
                                  message.role === "assistant" ? "bg-card/50" : "bg-primary/10"
                                }`}
                              >
                                <Show when={playground.extractMessageText(message.content)}>
                                  <pre class="whitespace-pre-wrap font-sans text-xs leading-relaxed">
                                    {playground.extractMessageText(message.content)}
                                  </pre>
                                </Show>
                                <Show when={playground.extractImageUrls(message.content).length > 0}>
                                  <div class="mt-1.5 flex flex-wrap gap-1.5">
                                    <For each={playground.extractImageUrls(message.content)}>
                                      {(url, imageIndex) => (
                                        <a
                                          href={url}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          class="block overflow-hidden rounded border border-border"
                                        >
                                          <img
                                            src={url}
                                            alt={`Attached image ${imageIndex() + 1}`}
                                            class="h-16 w-auto object-cover"
                                          />
                                        </a>
                                      )}
                                    </For>
                                  </div>
                                </Show>
                              </div>
                            </div>
                          </div>
                        )}
                      </For>
                    </Show>

                    <Show when={playground.responses()[panel.id]?.error}>
                      <div class="space-y-2">
                        <div
                          role="alert"
                          class="relative grid w-full grid-cols-[1rem_1fr] items-start gap-x-3 rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive"
                        >
                          <UiIcon name="i-lucide-alert-circle" class="size-4 translate-y-0.5" />
                          <div class="min-w-0">
                            <p class="font-medium">Error</p>
                            <p class="break-words text-sm text-destructive/90">{playground.responses()[panel.id]?.error}</p>
                          </div>
                          <UiTooltip text={playground.copiedError[panel.id] ? "Copied" : "Copy error"}>
                            <UiButton
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              class="absolute right-1.5 top-1.5 h-6 w-6 text-destructive/70 hover:text-destructive"
                              aria-label="Copy error"
                              onClick={() => void playground.copyError(panel.id)}
                            >
                              <UiIcon
                                name={playground.copiedError[panel.id] ? "i-lucide-check" : "i-lucide-copy"}
                                class="size-3.5"
                              />
                            </UiButton>
                          </UiTooltip>
                        </div>
                        <Show when={panel.modelId}>
                          <UiButton
                            type="button"
                            variant="outline"
                            size="sm"
                            class="w-full gap-1.5"
                            disabled={playground.responses()[panel.id]?.isLoading}
                            onClick={() => void playground.retryPanel(panel.id)}
                          >
                            <UiIcon name="i-lucide-rotate-cw" class="size-3.5" />
                            Retry
                          </UiButton>
                        </Show>
                      </div>
                    </Show>

                    <Show
                      when={
                        panel.modelId &&
                        !playground.isChatScenario() &&
                        (playground.responses()[panel.id]?.content ||
                          playground.responses()[panel.id]?.reasoning ||
                          playground.responses()[panel.id]?.toolCalls?.length ||
                          playground.responses()[panel.id]?.isLoading)
                      }
                    >
                      <div class="mb-2 flex gap-2">
                        <div class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary/80">
                          <UiIcon name="i-lucide-bot" class="size-3 text-secondary-foreground" />
                        </div>
                        <div class="min-w-0 flex-1">
                          <p class="mb-1 text-[11px] font-medium text-muted-foreground">Assistant</p>
                          <div class="space-y-2">
                            <Show when={playground.responses()[panel.id]?.reasoning}>
                              <div class="rounded-lg bg-amber-500/10 px-3 py-2 text-amber-100">
                                <p class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
                                  Reasoning
                                </p>
                                <pre class="whitespace-pre-wrap font-sans text-xs leading-relaxed">
                                  {playground.responses()[panel.id]?.reasoning}
                                  <Show when={playground.responses()[panel.id]?.isLoading && !playground.responses()[panel.id]?.content}>
                                    <span class="animate-pulse text-primary">▌</span>
                                  </Show>
                                </pre>
                              </div>
                            </Show>
                            <Show when={playground.responses()[panel.id]?.content}>
                              <div class="rounded-lg bg-card/50 px-3 py-2">
                                <pre class="whitespace-pre-wrap font-sans text-xs leading-relaxed">
                                  {playground.responses()[panel.id]?.content}
                                  <Show when={playground.responses()[panel.id]?.isLoading}>
                                    <span class="animate-pulse text-primary">▌</span>
                                  </Show>
                                </pre>
                              </div>
                            </Show>
                            <Show
                              when={
                                !playground.responses()[panel.id]?.content &&
                                !playground.responses()[panel.id]?.reasoning &&
                                playground.responses()[panel.id]?.isLoading
                              }
                            >
                              <div class="rounded-lg bg-card/50 px-3 py-2">
                                <pre class="whitespace-pre-wrap font-sans text-xs leading-relaxed">
                                  <span class="animate-pulse text-primary">▌</span>
                                </pre>
                              </div>
                            </Show>
                            <Show when={(playground.responses()[panel.id]?.toolCalls?.length ?? 0) > 0}>
                              <div class="rounded-lg bg-muted/20 px-3 py-2">
                                <div class="mb-1.5 flex items-center gap-1.5">
                                  <UiIcon name="i-lucide-wrench" class="size-3 text-muted-foreground" />
                                  <p class="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                    Tool Calls
                                  </p>
                                </div>
                                <div class="space-y-1.5">
                                  <For each={playground.responses()[panel.id]?.toolCalls ?? []}>
                                    {(toolCall) => (
                                      <div class="rounded bg-background/70 px-2 py-1.5">
                                        <p class="text-[11px] font-semibold text-foreground">{toolCall.name}</p>
                                        <pre class="mt-0.5 whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-muted-foreground">
                                          {playground.formatToolArguments(toolCall.arguments)}
                                        </pre>
                                      </div>
                                    )}
                                  </For>
                                </div>
                              </div>
                            </Show>
                          </div>
                        </div>
                      </div>
                    </Show>

                    <Show
                      when={
                        panel.modelId && playground.isChatScenario() && playground.responses()[panel.id]?.isLoading
                      }
                    >
                      <div class="mb-2 flex gap-2">
                        <div class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary/80">
                          <UiIcon name="i-lucide-bot" class="size-3 text-secondary-foreground" />
                        </div>
                        <div class="min-w-0 flex-1">
                          <p class="mb-1 text-[11px] font-medium text-muted-foreground">Assistant</p>
                          <div class="space-y-2">
                            <Show when={playground.responses()[panel.id]?.reasoning}>
                              <div class="rounded-lg bg-amber-500/10 px-3 py-2 text-amber-100">
                                <p class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
                                  Reasoning
                                </p>
                                <pre class="whitespace-pre-wrap font-sans text-xs leading-relaxed">
                                  {playground.responses()[panel.id]?.reasoning}
                                  <Show when={!playground.responses()[panel.id]?.content}>
                                    <span class="animate-pulse text-primary">▌</span>
                                  </Show>
                                </pre>
                              </div>
                            </Show>
                            <Show when={playground.responses()[panel.id]?.content}>
                              <div class="rounded-lg bg-card/50 px-3 py-2">
                                <pre class="whitespace-pre-wrap font-sans text-xs leading-relaxed">
                                  {playground.responses()[panel.id]?.content}
                                  <span class="animate-pulse text-primary">▌</span>
                                </pre>
                              </div>
                            </Show>
                            <Show when={!playground.responses()[panel.id]?.content && !playground.responses()[panel.id]?.reasoning}>
                              <div class="rounded-lg bg-card/50 px-3 py-2">
                                <pre class="whitespace-pre-wrap font-sans text-xs leading-relaxed">
                                  <span class="animate-pulse text-primary">▌</span>
                                </pre>
                              </div>
                            </Show>
                          </div>
                        </div>
                      </div>
                    </Show>

                    <Show
                      when={
                        panel.modelId &&
                        !playground.responses()[panel.id]?.isLoading &&
                        !playground.responses()[panel.id]?.content &&
                        !playground.responses()[panel.id]?.reasoning &&
                        !playground.responses()[panel.id]?.error &&
                        !playground.responses()[panel.id]?.toolCalls?.length &&
                        playground.conversationMessages(panel.id).length === 0
                      }
                    >
                      <p class="py-8 text-center text-sm text-muted-foreground">Response will appear here</p>
                    </Show>
                  </div>

                  <div class="shrink-0 bg-muted/15 px-3 py-2 text-[11px]">
                    <div class="flex items-center justify-between gap-2">
                      <span class="text-muted-foreground">Wait</span>
                      <div class="flex items-center gap-2">
                        <span class="font-medium tabular-nums">{playground.waitLabel(panel.id)}</span>
                        <Show when={panel.modelId && playground.responses()[panel.id]?.isLoading}>
                          <UiTooltip text="Stop">
                            <UiButton
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              class="h-5 w-5"
                              onClick={() => playground.stopPanel(panel.id)}
                            >
                              <UiIcon name="i-lucide-square" class="size-3" />
                            </UiButton>
                          </UiTooltip>
                        </Show>
                        <Show
                          when={
                            panel.modelId &&
                            !playground.responses()[panel.id]?.isLoading &&
                            !playground.responses()[panel.id]?.content &&
                            !playground.responses()[panel.id]?.reasoning &&
                            !playground.responses()[panel.id]?.error
                          }
                        >
                          <UiTooltip text="Run">
                            <UiButton
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              class="h-5 w-5"
                              onClick={() => void playground.retryPanel(panel.id)}
                            >
                              <UiIcon name="i-lucide-play" class="size-3 fill-current" />
                            </UiButton>
                          </UiTooltip>
                        </Show>
                        <Show
                          when={
                            panel.modelId &&
                            !playground.responses()[panel.id]?.isLoading &&
                            (playground.responses()[panel.id]?.content ||
                              playground.responses()[panel.id]?.reasoning ||
                              playground.responses()[panel.id]?.error)
                          }
                        >
                          <UiTooltip text="Retry">
                            <UiButton
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              class="h-5 w-5"
                              onClick={() => void playground.retryPanel(panel.id)}
                            >
                              <UiIcon name="i-lucide-rotate-cw" class="size-3" />
                            </UiButton>
                          </UiTooltip>
                        </Show>
                      </div>
                    </div>
                    <div class="mt-1 flex items-center justify-between gap-2">
                      <span class="shrink-0 whitespace-nowrap text-muted-foreground">Account</span>
                      <Show
                        when={playground.accountLink(panel)}
                        fallback={<span class="min-w-0 truncate text-right font-medium">{playground.routeLabel(panel)}</span>}
                      >
                        {(href) => (
                          <UiTooltip text="Open account">
                            <a
                              href={href()}
                              class="min-w-0 truncate text-right font-medium text-foreground underline-offset-2 hover:underline"
                            >
                              {playground.routeLabel(panel)}
                            </a>
                          </UiTooltip>
                        )}
                      </Show>
                    </div>
                  </div>
                </UiCardContent>
              </UiCard>
            )}
          </For>

          <Show when={playground.canAddPanel()}>
            <UiCard class="group h-[400px] overflow-hidden border border-dashed border-border/70 bg-card/20 p-0 shadow-none">
              <button
                type="button"
                class="flex h-full w-full cursor-pointer flex-col items-center justify-center gap-2 text-muted-foreground disabled:cursor-default disabled:opacity-50"
                aria-label="Add comparison card"
                onClick={playground.addPanel}
              >
                <span class="inline-flex size-10 items-center justify-center rounded-full bg-muted/20">
                  <UiIcon name="i-lucide-plus" class="size-4" />
                </span>
                <span class="text-sm font-medium">Add comparison</span>
              </button>
            </UiCard>
          </Show>
        </div>
      </div>
    </div>
  );
}

export default PlaygroundPage;
