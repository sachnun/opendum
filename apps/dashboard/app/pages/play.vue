<script setup lang="ts">
definePageMeta({ middleware: "auth", layout: "dashboard" });

const {
  SCENARIOS,
  ENDPOINT_OPTIONS,
  REASONING_OPTIONS,
  selectedScenario,
  settings,
  settingsOpen,
  panels,
  responses,
  loopDialogOpen,
  loopCountInput,
  additionalParametersInput,
  activeFamilyPresets,
  activeProviderPresets,
  familyPresetExpanded,
  providerPresetExpanded,
  selectionOpenByPanel,
  selectionStepByPanel,
  pendingModelByPanel,
  modelSearchByPanel,
  routeSearchByPanel,
  copiedErrorByPanel,
  modelsById,
  providerAccountsById,
  familyPresets,
  providerPresets,
  canAddPanel,
  isAnyLoading,
  isTopPDeprecated,
  additionalParametersError,
  canRunPlayground,
  isLoopCountValid,
  activeLoopBadgeLabel,
  isChatScenario,
  getValidProviderForPanel,
  getAccountLabel,
  getAccountPlaygroundStatus,
  getProviderPresetAccountLabel,
  getProviderScopedRouteLabel,
  getPendingModelProviders,
  getValidAccountIdForPanel,
  getSelectedRouteLabel,
  getPanelProviderAccountHref,
  shouldShowVisionWarning,
  getGroupedPanelModels,
  getPendingModelAccounts,
  openPanelPicker,
  setModelSearch,
  setRouteSearch,
  selectPendingModel,
  selectPanelRoute,
  addPanel,
  removePanel,
  applyFamilyPreset,
  applyProviderPreset,
  selectScenario,
  resetSettings,
  getScenarioConversationMessages,
  getPanelSystemPromptText,
  getPanelUserScenarioMessages,
  getPanelWaitLabel,
  setPanelScrollElement,
  handlePanelScroll,
  stopPanelRequest,
  stopAllRequests,
  retryPanel,
  handleStartPointerDown,
  handleStartPointerEnd,
  handleStartClick,
  runLoop,
  copyPanelError,
  error,
  getProviderLabel,
  extractMessageText,
  extractImageUrls,
  formatToolArguments,
} = usePlayground();
</script>

<template>
  <div>
  <UiDialog v-model:open="loopDialogOpen" :ui="{ content: 'sm:max-w-[400px]' }">
    <template #content>
      <div class="space-y-1.5 pr-6">
        <h2 class="text-lg font-semibold">Run Loop</h2>
        <p class="text-sm text-muted-foreground">Choose how many times to run the selected playground scenario.</p>
      </div>
      <label class="grid gap-2 text-sm font-medium">
        Loop count
        <input v-model="loopCountInput" type="number" inputmode="numeric" min="1" step="1" class="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" @keydown.enter.prevent="runLoop">
      </label>
      <div class="flex justify-end gap-2">
        <UiButton variant="outline" size="sm" @click="loopDialogOpen = false">Cancel</UiButton>
        <UiButton size="sm" :disabled="!isLoopCountValid" @click="runLoop">Run loop</UiButton>
      </div>
    </template>
  </UiDialog>

  <UiSheet v-model:open="settingsOpen" side="right" :ui="{ content: 'w-[88vw] max-w-sm overflow-y-auto p-0' }">
    <template #content>
      <div class="flex min-h-full flex-col">
        <div class="border-b border-border px-5 py-4">
          <h2 class="text-lg font-semibold">Settings</h2>
        </div>
        <div class="flex-1 space-y-6 px-5 py-5">
          <section class="space-y-4">
            <h3 class="text-sm font-medium uppercase tracking-wide text-muted-foreground">Endpoint</h3>
            <div class="space-y-2">
              <p class="text-sm font-medium">API Endpoint</p>
              <button
                v-for="option in ENDPOINT_OPTIONS"
                :key="option.value"
                type="button"
                :class="[
                  'flex h-auto w-full cursor-pointer flex-col items-start justify-start rounded-md border px-3 py-2 text-left text-sm disabled:cursor-default disabled:pointer-events-none disabled:opacity-50',
                  settings.endpoint === option.value ? 'border-primary/35 bg-primary/10 text-primary' : 'border-border/70 bg-card/30 text-muted-foreground',
                ]"
                :disabled="isAnyLoading"
                @click="settings.endpoint = option.value"
              >
                <span class="text-xs font-medium">{{ option.label }}</span>
                <span :class="settings.endpoint === option.value ? 'text-[11px] text-primary/80' : 'text-[11px] text-muted-foreground'">{{ option.description }}</span>
              </button>
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
              <UiSwitch v-model="settings.streamResponses" :disabled="isAnyLoading" />
            </div>
            <label class="grid gap-2 text-sm font-medium">
              <span class="flex items-center justify-between"><span>Temperature</span><span class="w-12 text-right text-sm text-muted-foreground">{{ settings.temperature.toFixed(1) }}</span></span>
              <input v-model.number="settings.temperature" type="range" min="0" max="2" step="0.1" :disabled="isAnyLoading" class="w-full accent-primary">
              <span class="text-xs font-normal text-muted-foreground">Higher values make output more creative and random</span>
            </label>
            <label class="grid gap-2 text-sm font-medium">
              <span class="flex items-center justify-between"><span>Top P</span><span class="w-12 text-right text-sm text-muted-foreground">{{ settings.topP.toFixed(2) }}</span></span>
              <input v-model.number="settings.topP" type="range" min="0" max="1" step="0.05" :disabled="isAnyLoading || isTopPDeprecated" class="w-full accent-primary">
              <span v-if="isTopPDeprecated" class="text-xs font-normal text-amber-600 dark:text-amber-400">This model's provider no longer accepts top_p; using default value (1.0)</span>
              <span v-else class="text-xs font-normal text-muted-foreground">Nucleus sampling threshold (1.0 = consider all tokens)</span>
            </label>
            <label class="grid gap-2 text-sm font-medium">
              Max Tokens
              <input v-model.number="settings.maxTokens" type="number" min="1" max="128000" :disabled="isAnyLoading" class="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
              <span class="text-xs font-normal text-muted-foreground">Maximum number of tokens to generate</span>
            </label>
          </section>

          <div class="h-px bg-border" />

          <section class="space-y-4">
            <h3 class="text-sm font-medium uppercase tracking-wide text-muted-foreground">Additional Parameters</h3>
            <label class="grid gap-2 text-sm font-medium">
              Request body JSON
              <textarea
                v-model="additionalParametersInput"
                rows="8"
                spellcheck="false"
                placeholder='{\n  "seed": 1234,\n  "metadata": { "case": "repro" }\n}'
                :disabled="isAnyLoading"
                class="min-h-40 resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-50"
                :class="additionalParametersError ? 'border-destructive focus-visible:border-destructive focus-visible:ring-destructive/30' : ''"
              />
              <span class="text-xs font-normal text-muted-foreground">Merged into the final request body after the selected scenario and settings. Values here can override generated fields.</span>
              <span v-if="additionalParametersError" class="text-xs font-normal text-destructive">{{ additionalParametersError }}</span>
            </label>
          </section>

          <div class="h-px bg-border" />

          <section class="space-y-4">
            <h3 class="text-sm font-medium uppercase tracking-wide text-muted-foreground">Penalties</h3>
            <label class="grid gap-2 text-sm font-medium">
              <span class="flex items-center justify-between"><span>Presence Penalty</span><span class="w-12 text-right text-sm text-muted-foreground">{{ settings.presencePenalty.toFixed(1) }}</span></span>
              <input v-model.number="settings.presencePenalty" type="range" min="-2" max="2" step="0.1" :disabled="isAnyLoading" class="w-full accent-primary">
              <span class="text-xs font-normal text-muted-foreground">Penalize tokens based on whether they appear in the text so far</span>
            </label>
            <label class="grid gap-2 text-sm font-medium">
              <span class="flex items-center justify-between"><span>Frequency Penalty</span><span class="w-12 text-right text-sm text-muted-foreground">{{ settings.frequencyPenalty.toFixed(1) }}</span></span>
              <input v-model.number="settings.frequencyPenalty" type="range" min="-2" max="2" step="0.1" :disabled="isAnyLoading" class="w-full accent-primary">
              <span class="text-xs font-normal text-muted-foreground">Penalize tokens based on how frequently they appear</span>
            </label>
          </section>

          <div class="h-px bg-border" />

          <section class="space-y-4">
            <h3 class="text-sm font-medium uppercase tracking-wide text-muted-foreground">Reasoning</h3>
            <div class="space-y-2">
              <p class="text-sm font-medium">Reasoning Effort</p>
              <div class="flex gap-1 overflow-x-auto">
                <UiButton
                  v-for="option in REASONING_OPTIONS"
                  :key="option.value"
                  size="sm"
                  variant="outline"
                  :class="['flex-1 border-border/70 bg-card/30 text-muted-foreground shadow-none hover:bg-card/30', settings.reasoningEffort === option.value ? (option.value === 'none' ? 'border-primary/35 bg-primary/10 text-primary hover:bg-primary/10' : 'border-amber-500/35 bg-amber-500/10 text-amber-200 hover:bg-amber-500/10') : '']"
                  :disabled="isAnyLoading"
                  @click="settings.reasoningEffort = option.value"
                >
                  {{ option.label }}
                </UiButton>
              </div>
              <p class="text-xs text-muted-foreground">Enable extended thinking for reasoning models.</p>
            </div>
          </section>
        </div>
        <div class="border-t border-border p-5">
          <UiButton variant="outline" class="w-full" :disabled="isAnyLoading" @click="resetSettings">
            <UiIcon name="i-lucide-rotate-ccw" class="size-4" />
            Reset to Defaults
          </UiButton>
        </div>
      </div>
    </template>
  </UiSheet>

  <div class="space-y-6">
    <div class="dashboard-header-divider">
      <div class="flex items-center justify-between gap-4">
        <h1 class="text-xl font-semibold">Playground</h1>
        <div class="flex items-center gap-2">
          <UiButton v-if="isAnyLoading" type="button" variant="outline" size="sm" @click="stopAllRequests">
            <span class="relative inline-flex">
              <UiIcon name="i-lucide-square" class="size-3.5" />
              <span v-if="activeLoopBadgeLabel" class="absolute -right-3 -top-2 rounded-full bg-primary px-1 py-0.5 text-[9px] font-semibold leading-none text-primary-foreground">{{ activeLoopBadgeLabel }}</span>
            </span>
            Stop all
          </UiButton>
          <UiButton type="button" variant="outline" size="sm" class="select-none" :disabled="!canRunPlayground" @click="handleStartClick" @pointerdown="handleStartPointerDown" @pointerup="handleStartPointerEnd" @pointerleave="handleStartPointerEnd" @pointercancel="handleStartPointerEnd" @selectstart.prevent @dragstart.prevent @contextmenu.prevent>
            <UiIcon name="i-lucide-play" class="size-4" />
            Start
          </UiButton>
          <UiTooltip text="Settings">
            <UiButton type="button" variant="outline" size="icon-sm" aria-label="Settings" @click="settingsOpen = true">
              <UiIcon name="i-lucide-settings" class="size-4" />
            </UiButton>
          </UiTooltip>
        </div>
      </div>
    </div>

    <DataNotice :error="error" />

      <div class="space-y-3">
        <h2 class="text-sm font-medium text-muted-foreground">Scenario</h2>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="scenario in SCENARIOS"
            :key="scenario.id"
            type="button"
            :disabled="isAnyLoading"
            :class="[
              'flex h-auto min-w-[72px] cursor-pointer flex-col items-center gap-1 rounded-md border px-3 py-2 text-sm font-medium disabled:cursor-default disabled:pointer-events-none disabled:opacity-50',
              selectedScenario.id === scenario.id ? (scenario.isReasoning ? 'border-amber-500/35 bg-amber-500/10 text-amber-200' : 'border-primary/35 bg-primary/10 text-primary') : (scenario.isReasoning ? 'border-dashed border-amber-500/25 bg-card/30 text-muted-foreground' : 'border-border/70 bg-card/30 text-muted-foreground'),
            ]"
            @click="selectScenario(scenario)"
          >
            <UiIcon :name="scenario.icon" class="size-4" />
            <span class="text-xs">{{ scenario.name }}</span>
          </button>
        </div>
      </div>

      <div class="space-y-3">
        <button type="button" class="flex w-full cursor-pointer items-center justify-between gap-3 text-left" :aria-expanded="familyPresetExpanded" @click="familyPresetExpanded = !familyPresetExpanded">
          <span class="text-sm font-medium text-muted-foreground">Family Preset</span>
          <span class="flex items-center gap-2 text-xs text-muted-foreground">
            {{ familyPresets.length }} groups
            <UiIcon :name="familyPresetExpanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="size-4" />
          </span>
        </button>
        <div v-if="familyPresetExpanded && familyPresets.length > 0" class="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap">
          <button
            v-for="preset in familyPresets"
            :key="preset.family"
            type="button"
            :disabled="isAnyLoading"
            :class="[
              'flex h-auto w-full min-w-0 cursor-pointer flex-col items-center gap-0.5 rounded-md border px-3 py-2 text-center text-sm font-medium disabled:cursor-default disabled:pointer-events-none disabled:opacity-50 sm:w-auto sm:min-w-[92px]',
              activeFamilyPresets.includes(preset.family) ? 'border-primary/35 bg-primary/10 text-primary' : 'border-border/70 bg-card/30 text-muted-foreground',
            ]"
            @click="applyFamilyPreset(preset.family)"
          >
            <span class="whitespace-normal break-words text-xs leading-tight">{{ preset.family }}</span>
            <span :class="activeFamilyPresets.includes(preset.family) ? 'text-[10px] leading-none text-primary/80' : 'text-[10px] leading-none text-muted-foreground'">{{ preset.models.length }} models</span>
          </button>
        </div>
      </div>

      <div class="space-y-3">
        <button type="button" class="flex w-full cursor-pointer items-center justify-between gap-3 text-left" :aria-expanded="providerPresetExpanded" @click="providerPresetExpanded = !providerPresetExpanded">
          <span class="text-sm font-medium text-muted-foreground">Provider Preset</span>
          <span class="flex items-center gap-2 text-xs text-muted-foreground">
            {{ providerPresets.length }} providers
            <UiIcon :name="providerPresetExpanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="size-4" />
          </span>
        </button>
        <div v-if="providerPresetExpanded && providerPresets.length > 0" class="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap">
          <button
            v-for="preset in providerPresets"
            :key="preset.provider"
            type="button"
            :disabled="isAnyLoading"
            :class="[
              'flex h-auto min-h-10 w-full min-w-0 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-md border px-3 py-2 text-center text-sm font-medium disabled:cursor-default disabled:pointer-events-none disabled:opacity-50 sm:w-auto sm:min-w-[92px]',
              activeProviderPresets.includes(preset.provider) ? 'border-primary/35 bg-primary/10 text-primary' : 'border-border/70 bg-card/30 text-muted-foreground',
            ]"
            @click="applyProviderPreset(preset.provider)"
          >
            <span class="whitespace-normal break-words text-xs leading-tight">{{ getProviderLabel(preset.provider) }}</span>
            <span v-if="getProviderPresetAccountLabel(preset.accounts)" :class="activeProviderPresets.includes(preset.provider) ? 'text-[10px] leading-none text-primary/80' : 'text-[10px] leading-none text-muted-foreground'">{{ getProviderPresetAccountLabel(preset.accounts) }}</span>
          </button>
        </div>
      </div>

      <div class="dashboard-card-grid">
        <UiCard v-for="panel in panels" :key="panel.id" class="relative flex h-[400px] flex-col gap-0 overflow-hidden border-border/70 bg-card/40 py-0 shadow-none">
          <UiTooltip v-if="panels.length > 1" text="Remove">
            <UiButton variant="ghost" size="icon-xs" class="absolute right-2 top-2 z-10 h-7 w-7 rounded-full bg-transparent p-0 text-muted-foreground" aria-label="Remove comparison card" @click="removePanel(panel.id)">
              <UiIcon name="i-lucide-x" class="size-3.5" />
            </UiButton>
          </UiTooltip>

          <UiCardHeader class="flex-none gap-0 bg-muted/10 py-2 pl-3" :class="panels.length > 1 ? 'pr-11' : 'pr-3'">
            <UiPopover v-model:open="selectionOpenByPanel[panel.id]" :content="{ align: 'start', class: 'w-[340px] max-w-[calc(100vw-2rem)] p-0' }">
              <UiButton type="button" variant="ghost" class="h-8 flex-1 justify-between bg-transparent px-0 font-normal shadow-none" :disabled="responses[panel.id]?.isLoading" @click="openPanelPicker(panel)">
                <span v-if="panel.modelId && modelsById.get(panel.modelId)" class="flex min-w-0 items-center gap-2">
                  <UiTooltip v-if="shouldShowVisionWarning(modelsById.get(panel.modelId))" text="This model may not support vision input">
                    <UiIcon name="i-lucide-triangle-alert" class="size-3.5 shrink-0 text-yellow-500" />
                  </UiTooltip>
                  <span class="truncate">{{ modelsById.get(panel.modelId)?.name }}</span>
                  <UiBadge variant="secondary" class="shrink-0 whitespace-nowrap bg-muted/40 px-1.5 py-0 text-[10px] text-muted-foreground">
                    {{ getValidAccountIdForPanel(panel) ? getProviderLabel(providerAccountsById.get(getValidAccountIdForPanel(panel)!)?.provider ?? '') : responses[panel.id]?.usedAccountId ? `Auto - ${getProviderLabel(providerAccountsById.get(responses[panel.id]?.usedAccountId ?? '')?.provider ?? '')}` : getValidProviderForPanel(panel) ? getProviderScopedRouteLabel(getValidProviderForPanel(panel)!) : 'Auto' }}
                  </UiBadge>
                </span>
                <span v-else class="text-muted-foreground">Select model...</span>
                <UiIcon name="i-lucide-chevron-down" class="ml-1 size-3 shrink-0 opacity-50" />
              </UiButton>
              <template #content>
                <div v-if="selectionStepByPanel[panel.id] !== 'routing'" class="max-h-[420px] overflow-hidden">
                  <div class="border-b p-2">
                    <input :value="modelSearchByPanel[panel.id] ?? ''" placeholder="Search models..." class="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none" @input="setModelSearch(panel.id, $event)">
                  </div>
                  <div class="max-h-[360px] overflow-y-auto p-1">
                    <p v-if="getGroupedPanelModels(panel).length === 0" class="px-2 py-6 text-center text-sm text-muted-foreground">No model found.</p>
                    <div v-for="group in getGroupedPanelModels(panel)" :key="group.family" class="py-1">
                      <p class="px-2 py-1.5 text-[11px] font-semibold text-muted-foreground">{{ group.family }}</p>
                      <button v-for="model in group.models" :key="model.id" type="button" class="flex w-full cursor-pointer items-start gap-2 rounded-sm px-2 py-2 text-left hover:bg-accent hover:text-accent-foreground" :class="panel.modelId === model.id ? 'bg-accent' : ''" @click="selectPendingModel(panel, model.id)">
                        <div class="min-w-0 flex-1">
                          <p class="truncate text-xs font-medium">{{ model.name }}</p>
                          <div class="mt-1 flex flex-wrap gap-1">
                            <UiBadge v-for="provider in model.providers" :key="`${model.id}-${provider}`" variant="outline" class="h-4 px-1.5 text-[9px]">{{ getProviderLabel(provider) }}</UiBadge>
                          </div>
                        </div>
                      </button>
                    </div>
                  </div>
                </div>
                <div v-else class="max-h-[420px] overflow-hidden">
                  <div class="flex items-center justify-between border-b px-2 py-1.5">
                    <UiButton type="button" variant="ghost" size="sm" class="h-7 gap-1 px-2 text-xs" @click="selectionStepByPanel[panel.id] = 'model'; pendingModelByPanel[panel.id] = null">
                      <UiIcon name="i-lucide-chevron-left" class="size-3.5" />
                      Models
                    </UiButton>
                    <p class="max-w-[220px] truncate text-xs font-medium">{{ pendingModelByPanel[panel.id] }}</p>
                  </div>
                  <div class="border-b p-2">
                    <input :value="routeSearchByPanel[panel.id] ?? ''" placeholder="Search provider or account..." class="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none" @input="setRouteSearch(panel.id, $event)">
                  </div>
                  <div class="max-h-[330px] overflow-y-auto p-1">
                    <p class="px-2 py-1.5 text-[11px] font-semibold text-muted-foreground">Routing</p>
                    <button type="button" class="flex w-full cursor-pointer items-center rounded-sm px-2 py-2 text-left hover:bg-accent hover:text-accent-foreground" :class="panel.modelId === pendingModelByPanel[panel.id] && !panel.provider && !panel.accountId ? 'bg-accent' : ''" @click="selectPanelRoute(panel, { provider: null, accountId: null })">
                      <div class="min-w-0 flex-1">
                        <p class="truncate text-xs font-medium">Auto (load balancer)</p>
                        <p class="truncate text-[10px] text-muted-foreground">System chooses best provider account</p>
                      </div>
                    </button>
                    <button v-for="provider in getPendingModelProviders(panel)" :key="`provider-${provider}`" type="button" class="flex w-full cursor-pointer items-center rounded-sm px-2 py-2 text-left hover:bg-accent hover:text-accent-foreground" :class="panel.modelId === pendingModelByPanel[panel.id] && panel.provider === provider && !panel.accountId ? 'bg-accent' : ''" @click="selectPanelRoute(panel, { provider, accountId: null })">
                      <div class="min-w-0 flex-1">
                        <p class="truncate text-xs font-medium">{{ getProviderScopedRouteLabel(provider) }}</p>
                        <p class="truncate text-[10px] text-muted-foreground">Load balance within {{ getProviderLabel(provider) }}</p>
                      </div>
                      <UiBadge variant="outline" class="ml-2 shrink-0 text-[10px]">{{ getProviderLabel(provider) }}</UiBadge>
                    </button>
                    <button v-for="account in getPendingModelAccounts(panel)" :key="account.id" type="button" class="flex w-full cursor-pointer items-center rounded-sm px-2 py-2 text-left hover:bg-accent hover:text-accent-foreground" :class="panel.modelId === pendingModelByPanel[panel.id] && panel.accountId === account.id ? 'bg-accent' : ''" @click="selectPanelRoute(panel, { provider: null, accountId: account.id })">
                      <div class="min-w-0 flex-1">
                        <p class="truncate text-xs font-medium">{{ getAccountLabel(account) }}</p>
                        <p class="truncate text-[10px] text-muted-foreground">{{ getProviderLabel(account.provider) }}</p>
                      </div>
                      <div class="ml-2 flex shrink-0 items-center gap-1">
                        <UiBadge v-if="getAccountPlaygroundStatus(account)" variant="secondary" class="text-[10px]">{{ getAccountPlaygroundStatus(account) }}</UiBadge>
                        <UiBadge variant="outline" class="text-[10px]">{{ getProviderLabel(account.provider) }}</UiBadge>
                      </div>
                    </button>
                  </div>
                </div>
              </template>
            </UiPopover>
          </UiCardHeader>

          <UiCardContent class="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
            <div :ref="(element: unknown) => setPanelScrollElement(panel.id, element)" class="min-h-0 flex-1 overflow-y-auto bg-background/20 p-3" @scroll="handlePanelScroll(panel.id, $event)">
              <template v-if="getScenarioConversationMessages(panel.id).length > 0">
                <pre v-if="getPanelSystemPromptText(panel.id)" class="mb-2 whitespace-pre-wrap font-sans text-[11px] leading-relaxed text-muted-foreground">{{ getPanelSystemPromptText(panel.id) }}</pre>

                <div v-for="(message, index) in getPanelUserScenarioMessages(panel.id)" :key="`${panel.id}-message-${index}`" class="mb-2 flex gap-2">
                  <div :class="message.role === 'assistant' ? 'bg-secondary/80' : 'bg-primary/10'" class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full">
                    <UiIcon :name="message.role === 'assistant' ? 'i-lucide-bot' : 'i-lucide-user'" :class="message.role === 'assistant' ? 'text-secondary-foreground' : 'text-primary'" class="size-3" />
                  </div>
                  <div class="min-w-0 flex-1">
                    <p :class="message.role === 'assistant' ? 'text-muted-foreground' : 'text-primary'" class="mb-1 text-[11px] font-medium">{{ message.role === 'assistant' ? 'Assistant' : 'User' }}</p>
                    <div :class="message.role === 'assistant' ? 'bg-card/50' : 'bg-primary/10'" class="rounded-lg px-3 py-2">
                      <pre v-if="extractMessageText(message.content)" class="whitespace-pre-wrap font-sans text-xs leading-relaxed">{{ extractMessageText(message.content) }}</pre>
                      <div v-if="extractImageUrls(message.content).length > 0" class="mt-1.5 flex flex-wrap gap-1.5">
                        <a v-for="(url, imageIndex) in extractImageUrls(message.content)" :key="`${panel.id}-${imageIndex}`" :href="url" target="_blank" rel="noopener noreferrer" class="block overflow-hidden rounded border border-border">
                          <img :src="url" :alt="`Attached image ${imageIndex + 1}`" class="h-16 w-auto object-cover">
                        </a>
                      </div>
                    </div>
                  </div>
                </div>
              </template>

              <div v-if="responses[panel.id]?.error" class="space-y-2">
                <div role="alert" class="relative grid w-full grid-cols-[1rem_1fr] items-start gap-x-3 rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  <UiIcon name="i-lucide-alert-circle" class="size-4 translate-y-0.5" />
                  <div class="min-w-0">
                    <p class="font-medium">Error</p>
                    <p class="break-words text-sm text-destructive/90">{{ responses[panel.id]?.error }}</p>
                  </div>
                  <UiTooltip :text="copiedErrorByPanel[panel.id] ? 'Copied' : 'Copy error'">
                    <UiButton type="button" variant="ghost" size="icon-xs" class="absolute right-1.5 top-1.5 h-6 w-6 text-destructive/70 hover:text-destructive" aria-label="Copy error" @click="copyPanelError(panel.id)">
                      <UiIcon :name="copiedErrorByPanel[panel.id] ? 'i-lucide-check' : 'i-lucide-copy'" class="size-3.5" />
                    </UiButton>
                  </UiTooltip>
                </div>
                <UiButton v-if="panel.modelId" type="button" variant="outline" size="sm" class="w-full gap-1.5" :disabled="responses[panel.id]?.isLoading" @click="retryPanel(panel.id)">
                  <UiIcon name="i-lucide-rotate-cw" class="size-3.5" />
                  Retry
                </UiButton>
              </div>

              <div v-if="panel.modelId && !isChatScenario && (responses[panel.id]?.content || responses[panel.id]?.reasoning || responses[panel.id]?.toolCalls?.length || responses[panel.id]?.isLoading)" class="mb-2 flex gap-2">
                <div class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary/80">
                  <UiIcon name="i-lucide-bot" class="size-3 text-secondary-foreground" />
                </div>
                <div class="min-w-0 flex-1">
                  <p class="mb-1 text-[11px] font-medium text-muted-foreground">Assistant</p>
                  <div class="space-y-2">
                    <div v-if="responses[panel.id]?.reasoning" class="rounded-lg bg-amber-500/10 px-3 py-2 text-amber-100">
                      <p class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-amber-300">Reasoning</p>
                      <pre class="whitespace-pre-wrap font-sans text-xs leading-relaxed">{{ responses[panel.id]?.reasoning }}<span v-if="responses[panel.id]?.isLoading && !responses[panel.id]?.content" class="animate-pulse text-primary">▌</span></pre>
                    </div>
                    <div v-if="responses[panel.id]?.content" class="rounded-lg bg-card/50 px-3 py-2">
                      <pre class="whitespace-pre-wrap font-sans text-xs leading-relaxed">{{ responses[panel.id]?.content }}<span v-if="responses[panel.id]?.isLoading" class="animate-pulse text-primary">▌</span></pre>
                    </div>
                    <div v-if="!responses[panel.id]?.content && !responses[panel.id]?.reasoning && responses[panel.id]?.isLoading" class="rounded-lg bg-card/50 px-3 py-2">
                      <pre class="whitespace-pre-wrap font-sans text-xs leading-relaxed"><span class="animate-pulse text-primary">▌</span></pre>
                    </div>
                    <div v-if="responses[panel.id]?.toolCalls?.length" class="rounded-lg bg-muted/20 px-3 py-2">
                      <div class="mb-1.5 flex items-center gap-1.5">
                        <UiIcon name="i-lucide-wrench" class="size-3 text-muted-foreground" />
                        <p class="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Tool Calls</p>
                      </div>
                      <div class="space-y-1.5">
                        <div v-for="(toolCall, index) in responses[panel.id]?.toolCalls" :key="`${toolCall.name}-${index}`" class="rounded bg-background/70 px-2 py-1.5">
                          <p class="text-[11px] font-semibold text-foreground">{{ toolCall.name }}</p>
                          <pre class="mt-0.5 whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-muted-foreground">{{ formatToolArguments(toolCall.arguments) }}</pre>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div v-if="panel.modelId && isChatScenario && responses[panel.id]?.isLoading" class="mb-2 flex gap-2">
                <div class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary/80">
                  <UiIcon name="i-lucide-bot" class="size-3 text-secondary-foreground" />
                </div>
                <div class="min-w-0 flex-1">
                  <p class="mb-1 text-[11px] font-medium text-muted-foreground">Assistant</p>
                  <div class="space-y-2">
                    <div v-if="responses[panel.id]?.reasoning" class="rounded-lg bg-amber-500/10 px-3 py-2 text-amber-100">
                      <p class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-amber-300">Reasoning</p>
                      <pre class="whitespace-pre-wrap font-sans text-xs leading-relaxed">{{ responses[panel.id]?.reasoning }}<span v-if="!responses[panel.id]?.content" class="animate-pulse text-primary">▌</span></pre>
                    </div>
                    <div v-if="responses[panel.id]?.content" class="rounded-lg bg-card/50 px-3 py-2">
                      <pre class="whitespace-pre-wrap font-sans text-xs leading-relaxed">{{ responses[panel.id]?.content }}<span class="animate-pulse text-primary">▌</span></pre>
                    </div>
                    <div v-if="!responses[panel.id]?.content && !responses[panel.id]?.reasoning" class="rounded-lg bg-card/50 px-3 py-2">
                      <pre class="whitespace-pre-wrap font-sans text-xs leading-relaxed"><span class="animate-pulse text-primary">▌</span></pre>
                    </div>
                  </div>
                </div>
              </div>

              <p v-if="panel.modelId && !responses[panel.id]?.isLoading && !responses[panel.id]?.content && !responses[panel.id]?.reasoning && !responses[panel.id]?.error && !responses[panel.id]?.toolCalls?.length && getScenarioConversationMessages(panel.id).length === 0" class="py-8 text-center text-sm text-muted-foreground">Response will appear here</p>
            </div>

            <div class="shrink-0 bg-muted/15 px-3 py-2 text-[11px]">
              <div class="flex items-center justify-between gap-2">
                <span class="text-muted-foreground">Wait</span>
                <div class="flex items-center gap-2">
                  <span class="font-medium tabular-nums">{{ getPanelWaitLabel(panel.id) }}</span>
                  <UiTooltip v-if="panel.modelId && responses[panel.id]?.isLoading" text="Stop">
                    <UiButton type="button" variant="ghost" size="icon-xs" class="h-5 w-5" @click="stopPanelRequest(panel.id)">
                      <UiIcon name="i-lucide-square" class="size-3" />
                    </UiButton>
                  </UiTooltip>
                  <UiTooltip v-if="panel.modelId && !responses[panel.id]?.isLoading && !responses[panel.id]?.content && !responses[panel.id]?.reasoning && !responses[panel.id]?.error" text="Run">
                    <UiButton type="button" variant="ghost" size="icon-xs" class="h-5 w-5" @click="retryPanel(panel.id)">
                      <UiIcon name="i-lucide-play" class="size-3 fill-current" />
                    </UiButton>
                  </UiTooltip>
                  <UiTooltip v-if="panel.modelId && !responses[panel.id]?.isLoading && (responses[panel.id]?.content || responses[panel.id]?.reasoning || responses[panel.id]?.error)" text="Retry">
                    <UiButton type="button" variant="ghost" size="icon-xs" class="h-5 w-5" @click="retryPanel(panel.id)">
                      <UiIcon name="i-lucide-rotate-cw" class="size-3" />
                    </UiButton>
                  </UiTooltip>
                </div>
              </div>
              <div class="mt-1 flex items-center justify-between gap-2">
                <span class="shrink-0 whitespace-nowrap text-muted-foreground">Account</span>
                <UiTooltip v-if="getPanelProviderAccountHref(panel)" text="Open account">
                  <NuxtLink
                    :to="getPanelProviderAccountHref(panel)!"
                    class="min-w-0 truncate text-right font-medium text-foreground underline-offset-2 hover:underline"
                  >
                    {{ getSelectedRouteLabel(panel) }}
                  </NuxtLink>
                </UiTooltip>
                <span v-else class="min-w-0 truncate text-right font-medium">{{ getSelectedRouteLabel(panel) }}</span>
              </div>
            </div>
          </UiCardContent>
        </UiCard>

        <UiCard v-if="canAddPanel" class="group h-[400px] overflow-hidden border border-dashed border-border/70 bg-card/20 p-0 shadow-none">
          <button type="button" class="flex h-full w-full cursor-pointer flex-col items-center justify-center gap-2 text-muted-foreground disabled:cursor-default disabled:opacity-50" aria-label="Add comparison card" @click="addPanel">
            <span class="inline-flex size-10 items-center justify-center rounded-full bg-muted/20">
              <UiIcon name="i-lucide-plus" class="size-4" />
            </span>
            <span class="text-sm font-medium">Add comparison</span>
          </button>
        </UiCard>
      </div>
  </div>
  </div>
</template>
