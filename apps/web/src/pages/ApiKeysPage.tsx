import { For, Show, createSignal, onCleanup, type JSX } from "solid-js";
import { Effect } from "effect";
import type { KeyListItem } from "~/lib/api-types";
import type { AccessMode } from "~/lib/access-draft";
import { api } from "~/api";
import { isAuditMode } from "~/lib/audit";
import { baseApiUrl } from "~/lib/config";
import { dataKeys } from "~/lib/data-keys";
import { invalidation } from "~/lib/invalidate";
import { createQuery } from "~/lib/query";
import { errorText, settle } from "~/lib/settle";
import { ApiKeyAccessSection } from "~/components/api-key/ApiKeyAccessSection";
import { ApiKeyAccountAccess } from "~/components/api-key/ApiKeyAccountAccess";
import { ApiKeyActions } from "~/components/api-key/ApiKeyActions";
import { ApiKeyExpiration } from "~/components/api-key/ApiKeyExpiration";
import { ApiKeyModelAccess } from "~/components/api-key/ApiKeyModelAccess";
import { ApiKeyRateLimit, type RateLimitRule } from "~/components/api-key/ApiKeyRateLimit";
import { CreateApiKeyButton } from "~/components/api-key/CreateApiKeyButton";
import { EditableApiKeyName } from "~/components/api-key/EditableApiKeyName";
import { DataNotice } from "~/components/common/DataNotice";
import { UiBadge } from "~/components/ui/UiBadge";
import { UiButton } from "~/components/ui/UiButton";
import { UiCard, UiCardContent, UiCardHeader } from "~/components/ui/UiCard";
import { UiIcon } from "~/components/ui/UiIcon";
import { UiSwitch } from "~/components/ui/UiSwitch";
import { UiTooltip } from "~/components/ui/UiTooltip";

type ApiKeyOptions = Awaited<ReturnType<typeof api.apiKeys.options>>;

interface PageData {
  apiKeys: KeyListItem[];
  options: ApiKeyOptions;
}

function keyStatus(apiKey: KeyListItem) {
  const now = new Date();

  if (apiKey.expiresAt && new Date(apiKey.expiresAt) < now) {
    return { label: "Expired", variant: "destructive" as const };
  }

  if (!apiKey.isActive) {
    return { label: "Disabled", variant: "secondary" as const };
  }

  return { label: "Active", variant: "default" as const };
}

function keyActive(apiKey: KeyListItem) {
  return keyStatus(apiKey).label === "Active";
}

function accessMode(mode: string): AccessMode {
  return mode === "whitelist" || mode === "blacklist" ? mode : "all";
}

function relativeTime(value: string | Date) {
  const date = new Date(value);
  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60_000);

  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}

function accessBadge(mode: string) {
  const normalizedMode = mode === "whitelist" || mode === "blacklist" ? mode : "all";
  return normalizedMode === "all" ? undefined : normalizedMode;
}

export function ApiKeysPage(): JSX.Element {
  const pageQuery = createQuery<PageData>(dataKeys.apiKeys, async () => {
    const loaded = await Effect.runPromise(
      Effect.all([Effect.promise(() => api.apiKeys.list()), Effect.promise(() => api.apiKeys.options())])
    );
    return { apiKeys: loaded[0], options: loaded[1] };
  });

  const [togglingIds, setTogglingIds] = createSignal(new Set<string>());
  const [toggleErrors, setToggleErrors] = createSignal<Record<string, string>>({});
  const [roamingUpdatingIds, setRoamingUpdatingIds] = createSignal(new Set<string>());
  const [roamingErrors, setRoamingErrors] = createSignal<Record<string, string>>({});
  const [copiedProxy, setCopiedProxy] = createSignal(false);
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  const apiKeys = () => pageQuery.data()?.apiKeys ?? [];
  const options = () => pageQuery.data()?.options ?? null;
  const activeCount = () => apiKeys().filter((apiKey) => keyStatus(apiKey).label === "Active").length;
  const proxyBaseUrl = () => `${String(baseApiUrl() || "").replace(/\/$/, "")}/v1`;

  async function copyProxy() {
    const copied = await settle(() => navigator.clipboard.writeText(proxyBaseUrl()));
    if (!copied.ok) return;
    setCopiedProxy(true);
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      setCopiedProxy(false);
      copyTimer = null;
    }, 1800);
  }

  onCleanup(() => {
    if (copyTimer) clearTimeout(copyTimer);
  });

  function limitsOf(apiKeyId: string): RateLimitRule[] {
    return options()?.rateLimitsByKeyId[apiKeyId] ?? [];
  }

  function limitBadge(apiKeyId: string) {
    const count = limitsOf(apiKeyId).length;
    return count > 0 ? `${count} limit${count === 1 ? "" : "s"}` : undefined;
  }

  function formatPoints(value: number) {
    return value.toLocaleString("en-US");
  }

  function patchPage(patcher: (value: PageData) => PageData) {
    const current = pageQuery.data();
    if (!current) return;
    pageQuery.setData(patcher(current));
  }

  function applyState(apiKeyId: string, value: { isActive: boolean; expiresAt: string | Date | null }) {
    patchPage((current) => ({
      ...current,
      apiKeys: current.apiKeys.map((apiKey) => (apiKey.id === apiKeyId ? { ...apiKey, ...value } : apiKey)),
    }));
  }

  function applyPatch(apiKeyId: string, value: Partial<KeyListItem>) {
    patchPage((current) => ({
      ...current,
      apiKeys: current.apiKeys.map((apiKey) => (apiKey.id === apiKeyId ? { ...apiKey, ...value } : apiKey)),
    }));
    invalidation.patchApiKey(apiKeyId, value);
  }

  function removeKey(apiKeyId: string) {
    patchPage((current) => {
      const { [apiKeyId]: _removedRateLimits, ...remainingRateLimits } = current.options.rateLimitsByKeyId;
      return {
        ...current,
        apiKeys: current.apiKeys.filter((apiKey) => apiKey.id !== apiKeyId),
        options: { ...current.options, rateLimitsByKeyId: remainingRateLimits },
      };
    });
    invalidation.removeApiKey(apiKeyId);
  }

  async function toggleKey(apiKey: KeyListItem) {
    if (isAuditMode()) return;
    if (togglingIds().has(apiKey.id)) return;

    setTogglingIds(new Set(togglingIds()).add(apiKey.id));
    setToggleErrors({ ...toggleErrors(), [apiKey.id]: "" });

    const toggled = await settle(() => api.apiKeys.toggle({ id: apiKey.id }));
    const afterToggle = new Set(togglingIds());
    afterToggle.delete(apiKey.id);
    setTogglingIds(afterToggle);
    if (!toggled.ok) {
      setToggleErrors({ ...toggleErrors(), [apiKey.id]: errorText(toggled.error, "Failed to toggle API key") });
      return;
    }
    if (!toggled.value.success) {
      setToggleErrors({ ...toggleErrors(), [apiKey.id]: toggled.value.error });
      return;
    }
    applyState(apiKey.id, { isActive: toggled.value.data.isActive, expiresAt: toggled.value.data.expiresAt });
  }

  async function toggleRoaming(apiKey: KeyListItem, enabled: boolean) {
    if (isAuditMode()) return;
    if (roamingUpdatingIds().has(apiKey.id)) return;

    setRoamingUpdatingIds(new Set(roamingUpdatingIds()).add(apiKey.id));
    setRoamingErrors({ ...roamingErrors(), [apiKey.id]: "" });

    const updated = await settle(() => api.apiKeys.updateRoaming({ id: apiKey.id, enabled }));
    const afterUpdate = new Set(roamingUpdatingIds());
    afterUpdate.delete(apiKey.id);
    setRoamingUpdatingIds(afterUpdate);
    if (!updated.ok) {
      setRoamingErrors({ ...roamingErrors(), [apiKey.id]: errorText(updated.error, "Failed to update roaming") });
      return;
    }
    if (!updated.value.success) {
      setRoamingErrors({ ...roamingErrors(), [apiKey.id]: updated.value.error });
      return;
    }
    applyPatch(apiKey.id, { roamingEnabled: updated.value.data.roamingEnabled });
  }

  function updateModels(apiKeyId: string, value: { mode: AccessMode; models: string[] }) {
    patchPage((current) => ({
      ...current,
      apiKeys: current.apiKeys.map((apiKey) =>
        apiKey.id === apiKeyId ? { ...apiKey, modelAccessMode: value.mode, modelAccessList: value.models } : apiKey
      ),
    }));
  }

  function updateAccess(apiKeyId: string, value: { mode: AccessMode; accounts: string[] }) {
    patchPage((current) => ({
      ...current,
      apiKeys: current.apiKeys.map((apiKey) =>
        apiKey.id === apiKeyId ? { ...apiKey, accountAccessMode: value.mode, accountAccessList: value.accounts } : apiKey
      ),
    }));
  }

  function saveLimits(apiKeyId: string, rules: RateLimitRule[]) {
    patchPage((current) => ({
      ...current,
      options: {
        ...current.options,
        rateLimitsByKeyId: { ...current.options.rateLimitsByKeyId, [apiKeyId]: rules },
      },
    }));
  }

  const pointsBalance = () => 0;

  return (
    <div class="space-y-6">
      <div class="web-header-divider">
        <div class="flex min-h-9 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 class="inline-flex min-h-9 items-center gap-2 text-xl font-semibold">
            API Keys
            <Show when={apiKeys().length > 0}>
              <UiBadge variant="outline" class="text-xs">
                {activeCount()}/{apiKeys().length}
              </UiBadge>
            </Show>
          </h2>
          <div class="flex w-full items-center sm:w-auto">
            <CreateApiKeyButton
              readonly={isAuditMode()}
              triggerClass="flex-1 sm:w-auto sm:flex-none"
              onCreated={() => void pageQuery.refresh()}
            />
          </div>
        </div>
      </div>

      <DataNotice error={pageQuery.error()} />

      <UiCard class="bg-card">
        <UiCardContent class="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div class="min-w-0 space-y-1">
            <p class="text-sm font-medium">Proxy Base URL</p>
            <code class="block break-all text-sm text-muted-foreground">{proxyBaseUrl()}</code>
          </div>
          <UiButton type="button" variant="outline" class="shrink-0" onClick={() => void copyProxy()}>
            <UiIcon name={copiedProxy() ? "i-lucide-check" : "i-lucide-copy"} class="size-4" />
            {copiedProxy() ? "Copied" : "Copy"}
          </UiButton>
        </UiCardContent>
      </UiCard>

      <Show when={apiKeys().length > 0}>
        <section class="scroll-mt-24 space-y-4 md:space-y-2">
          <div class="web-card-grid">
            <For each={apiKeys()}>
              {(apiKey) => (
                <UiCard
                  class={`flex h-full flex-col bg-transparent transition-colors ${
                    keyStatus(apiKey).label !== "Active" ? "opacity-65" : ""
                  }`}
                >
                  <UiCardHeader class="pb-1">
                    <div class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                      <div class="min-w-0 overflow-hidden">
                        <EditableApiKeyName
                          id={apiKey.id}
                          name={apiKey.name}
                          keyPreview={apiKey.keyPreview}
                          showEditButton={false}
                          readonly={isAuditMode()}
                          pointsBalance={pointsBalance()}
                          onUpdated={(value) => applyPatch(apiKey.id, value)}
                        />
                      </div>
                      <div class="flex h-7 shrink-0 items-center justify-end gap-1.5">
                        <span class="text-[11px] leading-none text-muted-foreground">{keyActive(apiKey) ? "On" : "Off"}</span>
                        <UiSwitch
                          checked={keyActive(apiKey)}
                          disabled={togglingIds().has(apiKey.id) || isAuditMode()}
                          title={keyActive(apiKey) ? "Disable" : "Enable"}
                          onCheckedChange={() => void toggleKey(apiKey)}
                        />
                      </div>
                    </div>
                    <Show when={toggleErrors()[apiKey.id]}>
                      <p class="mt-1 text-xs text-destructive">{toggleErrors()[apiKey.id]}</p>
                    </Show>
                  </UiCardHeader>

                  <UiCardContent class="flex flex-1 flex-col pt-0">
                    <div class="flex-1 space-y-3 text-sm">
                      <ApiKeyActions
                        apiKey={apiKey}
                        readonly={isAuditMode()}
                        pointsBalance={pointsBalance()}
                        onRenamed={(value) => applyPatch(apiKey.id, value)}
                        onDeleted={removeKey}
                      />

                      <div class="space-y-2 pt-2">
                        <div class="flex items-center justify-between gap-4">
                          <span class="text-muted-foreground">Expiration</span>
                          <div class="text-right">
                            <ApiKeyExpiration
                              apiKeyId={apiKey.id}
                              initialExpiresAt={apiKey.expiresAt}
                              readonly={isAuditMode()}
                              onUpdated={(value) => applyPatch(apiKey.id, value)}
                            />
                          </div>
                        </div>
                        <div class="flex justify-between gap-4">
                          <span class="text-muted-foreground">Last used</span>
                          <span class="text-right font-medium">
                            {apiKey.lastUsedAt ? relativeTime(apiKey.lastUsedAt) : "-"}
                          </span>
                        </div>
                        <div class="flex items-center justify-between gap-4">
                          <span class="flex items-center gap-1.5 text-muted-foreground">
                            Roaming
                            <UiTooltip side="top" align="start" contentClass="w-64 px-2 py-1.5 text-xs leading-snug">
                              <button
                                type="button"
                                class="hidden size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/60 outline-none transition-colors hover:text-foreground focus:outline-none focus-visible:outline-none focus-visible:ring-0 [@media(hover:hover)_and_(pointer:fine)]:inline-flex"
                                aria-label="About Roaming"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <UiIcon name="i-lucide-circle-question-mark" class="size-3 [stroke-width:1.5]" />
                              </button>
                            </UiTooltip>
                          </span>
                          <div class="flex items-center gap-1.5">
                            <Show when={apiKey.roamingEnabled}>
                              <span class="flex items-center gap-1 text-[11px] leading-none text-foreground">
                                <UiIcon name="i-lucide-coins" class="size-3" />
                                <span class="inline-flex items-center leading-none tabular-nums">
                                  {formatPoints(apiKey.roamingPointsUsed)}
                                </span>
                              </span>
                            </Show>
                            <UiSwitch
                              checked={apiKey.roamingEnabled}
                              size="sm"
                              title={apiKey.roamingEnabled ? "Disable" : "Enable"}
                              disabled={isAuditMode() || roamingUpdatingIds().has(apiKey.id)}
                              onCheckedChange={(checked) => void toggleRoaming(apiKey, checked)}
                            />
                          </div>
                        </div>
                        <Show when={roamingErrors()[apiKey.id]}>
                          <p class="text-right text-xs text-destructive">{roamingErrors()[apiKey.id]}</p>
                        </Show>
                      </div>

                      <div class="grid gap-2.5 border-t border-border/60 pt-3">
                        <ApiKeyAccessSection title="Model Access" badge={accessBadge(apiKey.modelAccessMode)}>
                          <ApiKeyModelAccess
                            apiKeyId={apiKey.id}
                            availableModels={options()?.modelAccessModels ?? options()?.availableModels ?? []}
                            initialMode={accessMode(apiKey.modelAccessMode)}
                            initialModels={apiKey.modelAccessList}
                            readonly={isAuditMode()}
                            onUpdated={(value) => updateModels(apiKey.id, value)}
                          />
                        </ApiKeyAccessSection>

                        <ApiKeyAccessSection title="Account Access" badge={accessBadge(apiKey.accountAccessMode)}>
                          <ApiKeyAccountAccess
                            apiKeyId={apiKey.id}
                            availableAccounts={options()?.providerAccounts ?? []}
                            initialMode={accessMode(apiKey.accountAccessMode)}
                            initialAccounts={apiKey.accountAccessList}
                            readonly={isAuditMode()}
                            onUpdated={(value) => updateAccess(apiKey.id, value)}
                          />
                        </ApiKeyAccessSection>

                        <ApiKeyAccessSection title="Rate Limits" badge={limitBadge(apiKey.id)}>
                          <ApiKeyRateLimit
                            apiKeyId={apiKey.id}
                            availableModels={options()?.availableModels ?? []}
                            availableFamilies={options()?.availableFamilies ?? []}
                            initialRules={limitsOf(apiKey.id)}
                            readonly={isAuditMode()}
                            onUpdated={(rules) => saveLimits(apiKey.id, rules)}
                          />
                        </ApiKeyAccessSection>
                      </div>
                    </div>
                  </UiCardContent>
                </UiCard>
              )}
            </For>
          </div>
        </section>
      </Show>
    </div>
  );
}

export default ApiKeysPage;
