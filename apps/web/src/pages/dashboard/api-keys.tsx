import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiKeyListItem, ApiKeyOptions } from "../../lib/dashboard-api-types";
import { useDashboardApi } from "../../hooks/useDashboardApi";
import { useDashboardAudit } from "../../hooks/useDashboardAudit";
import { dashboardDataKeys, useDashboardData } from "../../hooks/useDashboardDataInvalidation";
import { DashboardDataNotice } from "../../components/DashboardDataNotice";
import { UiBadge } from "../../components/ui/UiBadge";
import { UiButton } from "../../components/ui/UiButton";
import { UiCard, UiCardContent, UiCardHeader } from "../../components/ui/UiCard";
import { UiDialog } from "../../components/ui/UiDialog";
import { UiIcon } from "../../components/ui/UiIcon";
import { UiPopover } from "../../components/ui/UiPopover";
import { UiSwitch } from "../../components/ui/UiSwitch";
import { UiTooltip } from "../../components/ui/UiTooltip";
import { cn } from "../../lib/utils";

type AccessMode = "all" | "whitelist" | "blacklist";
type RateLimitRule = { target: string; targetType: "model" | "family"; perMinute: number | null; perHour: number | null; perDay: number | null };

const PROXY_BASE_URL = `${(import.meta.env.VITE_PROXY_URL || "").replace(/\/$/, "")}/v1`;

function getApiKeyStatus(apiKey: ApiKeyListItem) {
  const now = new Date();
  if (apiKey.expiresAt && new Date(apiKey.expiresAt) < now) return { label: "Expired", variant: "destructive" as const };
  if (!apiKey.isActive) return { label: "Disabled", variant: "secondary" as const };
  return { label: "Active", variant: "default" as const };
}

function formatRelativeTime(value: string | Date) {
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

function normalizeMode(mode: string): AccessMode {
  return mode === "whitelist" || mode === "blacklist" ? mode : "all";
}

function ApiKeyAccessSection({ title, badge, children }: { title: string; badge?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{title}</p>
        {badge ? (
          <UiBadge variant="outline" className="text-[10px] font-normal lowercase">{badge}</UiBadge>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function CreateApiKeyButton({ readonly, onCreated }: { readonly: boolean; onCreated: () => void }) {
  const dashboardApi = useDashboardApi();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [createdKey, setCreatedKey] = useState<{ id: string; key: string; keyPreview: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const handleCreate = async () => {
    setIsLoading(true);
    setErrorMessage("");
    try {
      const result = await dashboardApi.apiKeys.create({ name: name.trim() || undefined });
      if (!result.success) throw new Error(result.error);
      setCreatedKey(result.data);
      onCreated();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to create API key");
    } finally {
      setIsLoading(false);
    }
  };

  const copyKey = async () => {
    if (!createdKey) return;
    await navigator.clipboard.writeText(createdKey.key);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <UiButton variant="outline" className="flex-1 sm:w-auto sm:flex-none" disabled={readonly} onClick={() => setOpen(true)}>
        <UiIcon name="i-lucide-plus" className="size-4" />
        Create API Key
      </UiButton>
      <UiDialog open={open} onOpenChange={setOpen}>
        {createdKey ? (
          <>
            <div className="space-y-1.5 pr-6">
              <h2 className="text-lg font-semibold leading-none tracking-tight">API Key Created</h2>
              <p className="text-sm text-muted-foreground">Copy your API key now. You won't be able to see it again.</p>
            </div>
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <code className="block break-all font-mono text-xs">{createdKey.key}</code>
            </div>
            {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}
            <div className="flex justify-end gap-2">
              <UiButton variant="outline" size="sm" onClick={() => void copyKey()}>
                <UiIcon name={copied ? "i-lucide-check" : "i-lucide-copy"} className="size-3.5" />
                {copied ? "Copied" : "Copy"}
              </UiButton>
              <UiButton size="sm" onClick={() => { setOpen(false); setCreatedKey(null); setName(""); }}>Done</UiButton>
            </div>
          </>
        ) : (
          <>
            <div className="space-y-1.5 pr-6">
              <h2 className="text-lg font-semibold leading-none tracking-tight">Create API Key</h2>
              <p className="text-sm text-muted-foreground">Generate a new API key for the proxy.</p>
            </div>
            <label className="grid gap-1.5 text-sm font-medium">
              Name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="My API key"
                disabled={isLoading}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
              />
            </label>
            {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}
            <div className="flex justify-end gap-2">
              <UiButton variant="outline" size="sm" onClick={() => setOpen(false)}>Cancel</UiButton>
              <UiButton size="sm" disabled={isLoading} onClick={() => void handleCreate()}>
                {isLoading ? <UiIcon name="i-lucide-loader-2" className="size-3.5 animate-spin" /> : null}
                Create
              </UiButton>
            </div>
          </>
        )}
      </UiDialog>
    </>
  );
}

function ApiKeyActions({ apiKey, readonly, onDeleted, onRenamed }: { apiKey: ApiKeyListItem; readonly: boolean; onDeleted: (id: string) => void; onRenamed: (value: { name: string | null; keyPreview?: string }) => void }) {
  const dashboardApi = useDashboardApi();
  const [isRevealed, setIsRevealed] = useState(false);
  const [isTemporarilyRevealed, setIsTemporarilyRevealed] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(apiKey.name ?? "");

  const isKeyVisible = (isRevealed || isTemporarilyRevealed) && Boolean(revealedKey);
  const displayKey = isKeyVisible && revealedKey ? revealedKey : apiKey.keyPreview;

  const revealKey = async () => {
    if (readonly) return;
    if (isRevealed) {
      setIsRevealed(false);
      setIsTemporarilyRevealed(false);
      setRevealedKey(null);
      return;
    }
    if (isTemporarilyRevealed) {
      setIsTemporarilyRevealed(false);
      setRevealedKey(null);
      return;
    }
    if (revealedKey) {
      setIsTemporarilyRevealed(false);
      setIsRevealed(true);
      return;
    }
    setIsLoading(true);
    setErrorMessage("");
    try {
      const result = await dashboardApi.apiKeys.reveal({ id: apiKey.id });
      if (!result.success) throw new Error(result.error);
      setRevealedKey(result.data.key);
      setIsRevealed(true);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to reveal API key");
    } finally {
      setIsLoading(false);
    }
  };

  const copyKey = async () => {
    if (readonly) return;
    let key = revealedKey;
    setIsLoading(true);
    setErrorMessage("");
    try {
      if (!key) {
        const result = await dashboardApi.apiKeys.reveal({ id: apiKey.id });
        if (!result.success) throw new Error(result.error);
        key = result.data.key;
      }
      await navigator.clipboard.writeText(key);
      setRevealedKey(key);
      setIsTemporarilyRevealed(!isRevealed);
      setCopied(true);
      window.setTimeout(() => {
        setCopied(false);
        setIsTemporarilyRevealed(false);
        if (!isRevealed) setRevealedKey(null);
      }, 2000);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to copy API key");
    } finally {
      setIsLoading(false);
    }
  };

  const deleteKey = async () => {
    if (readonly) return;
    setIsDeleting(true);
    setErrorMessage("");
    try {
      const result = await dashboardApi.apiKeys.delete({ id: apiKey.id });
      if (!result.success) throw new Error(result.error);
      setDeleteDialogOpen(false);
      onDeleted(apiKey.id);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to delete API key");
    } finally {
      setIsDeleting(false);
    }
  };

  const saveName = async () => {
    setIsLoading(true);
    setErrorMessage("");
    try {
      const result = await dashboardApi.apiKeys.updateName({ id: apiKey.id, name: nameDraft.trim() });
      if (!result.success) throw new Error(result.error);
      onRenamed(result.data);
      setEditing(false);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to rename API key");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        {editing ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <input
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              disabled={isLoading}
              className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
            <UiButton size="icon-xs" variant="outline" disabled={isLoading} onClick={() => void saveName()}>
              <UiIcon name="i-lucide-check" className="size-3" />
            </UiButton>
            <UiButton size="icon-xs" variant="ghost" onClick={() => setEditing(false)}>
              <UiIcon name="i-lucide-x" className="size-3" />
            </UiButton>
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <code className={cn("block min-w-0 flex-1 break-all font-mono text-xs text-muted-foreground", isKeyVisible ? "text-foreground" : "")}>{displayKey}</code>
            <UiTooltip text={readonly ? "" : "Rename"}>
              <button type="button" disabled={readonly} className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:cursor-default disabled:opacity-50" aria-label="Rename API key" onClick={() => { setNameDraft(apiKey.name ?? ""); setEditing(true); }}>
                <UiIcon name="i-lucide-pencil" className="size-3" />
              </button>
            </UiTooltip>
          </div>
        )}
        <div className="flex shrink-0 items-center gap-0.5">
          <UiTooltip text={readonly ? "" : isRevealed ? "Hide" : "Reveal"}>
            <button type="button" disabled={readonly || isLoading} className="inline-flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:cursor-default disabled:opacity-50" aria-label="Reveal API key" onClick={() => void revealKey()}>
              <UiIcon name={isLoading ? "i-lucide-loader-2" : isKeyVisible ? "i-lucide-eye-off" : "i-lucide-eye"} className={cn("size-3", isLoading && "animate-spin")} />
            </button>
          </UiTooltip>
          <UiTooltip text={readonly ? "" : copied ? "Copied" : "Copy"}>
            <button type="button" disabled={readonly || isLoading} className="inline-flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:cursor-default disabled:opacity-50" aria-label="Copy API key" onClick={() => void copyKey()}>
              <UiIcon name={copied ? "i-lucide-check" : "i-lucide-copy"} className="size-3" />
            </button>
          </UiTooltip>
          <UiTooltip text={readonly ? "" : "Delete"}>
            <button type="button" disabled={readonly} className="inline-flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-default disabled:opacity-50" aria-label="Delete API key" onClick={() => setDeleteDialogOpen(true)}>
              <UiIcon name="i-lucide-trash-2" className="size-3" />
            </button>
          </UiTooltip>
        </div>
      </div>
      {errorMessage ? <p className="text-xs text-destructive">{errorMessage}</p> : null}

      <UiDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <div className="space-y-1.5 pr-6">
          <h2 className="text-lg font-semibold leading-none tracking-tight">Delete API Key</h2>
          <p className="text-sm text-muted-foreground">This API key will stop working immediately. This action cannot be undone.</p>
        </div>
        <div className="flex justify-end gap-2">
          <UiButton variant="outline" size="sm" onClick={() => setDeleteDialogOpen(false)}>Cancel</UiButton>
          <UiButton variant="destructive" size="sm" disabled={isDeleting} onClick={() => void deleteKey()}>Delete</UiButton>
        </div>
      </UiDialog>
    </div>
  );
}

function ApiKeyExpiration({ apiKeyId, initialExpiresAt, readonly, onUpdated }: { apiKeyId: string; initialExpiresAt: string | Date | null; readonly: boolean; onUpdated: (value: { expiresAt: string | Date | null }) => void }) {
  const dashboardApi = useDashboardApi();
  const [expiresAt, setExpiresAt] = useState<string | Date | null>(initialExpiresAt);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const update = async (next: string | Date | null) => {
    if (readonly) return;
    setIsLoading(true);
    setErrorMessage("");
    try {
      const result = await dashboardApi.apiKeys.updateExpiration({ id: apiKeyId, expiresAt: next });
      if (!result.success) throw new Error(result.error);
      setExpiresAt(result.data.expiresAt);
      onUpdated({ expiresAt: result.data.expiresAt });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to update expiration");
    } finally {
      setIsLoading(false);
    }
  };

  const formatted = expiresAt ? new Date(expiresAt).toLocaleDateString() : "Never";

  return (
    <UiPopover
      trigger={
        <button type="button" disabled={readonly || isLoading} className="inline-flex cursor-pointer items-center gap-1 rounded text-xs font-medium text-foreground transition-colors hover:text-muted-foreground disabled:cursor-default disabled:opacity-50">
          {isLoading ? <UiIcon name="i-lucide-loader-2" className="size-3 animate-spin" /> : <UiIcon name="i-lucide-calendar" className="size-3" />}
          {formatted}
        </button>
      }
      content={{ align: "end", className: "w-64 p-3" }}
    >
      <div className="space-y-2">
        <p className="text-xs font-medium text-foreground">Expiration</p>
        <div className="flex gap-1.5">
          <UiButton size="sm" variant="outline" className="flex-1" onClick={() => void update(null)}>Never</UiButton>
          <UiButton size="sm" variant="outline" className="flex-1" onClick={() => void update(new Date(Date.now() + 30 * 24 * 3600 * 1000))}>30 days</UiButton>
          <UiButton size="sm" variant="outline" className="flex-1" onClick={() => void update(new Date(Date.now() + 365 * 24 * 3600 * 1000))}>1 year</UiButton>
        </div>
        {errorMessage ? <p className="text-xs text-destructive">{errorMessage}</p> : null}
      </div>
    </UiPopover>
  );
}

function AccessModeSelector({ mode, onModeChange, disabled }: { mode: AccessMode; onModeChange: (mode: AccessMode) => void; disabled: boolean }) {
  const options: Array<{ value: AccessMode; label: string }> = [
    { value: "all", label: "All" },
    { value: "whitelist", label: "Whitelist" },
    { value: "blacklist", label: "Blacklist" },
  ];
  return (
    <div className="flex gap-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          className={cn(
            "inline-flex h-6 cursor-pointer items-center rounded border px-2 text-[11px] font-medium transition-colors disabled:cursor-default disabled:opacity-50",
            mode === option.value ? "border-primary/35 bg-primary/10 text-primary" : "border-border/70 text-muted-foreground hover:text-foreground",
          )}
          onClick={() => onModeChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ApiKeyModelAccess({ apiKeyId, availableModels, initialMode, initialModels, readonly, onUpdated }: { apiKeyId: string; availableModels: Array<{ id: string; label: string }>; initialMode: AccessMode; initialModels: string[]; readonly: boolean; onUpdated: (value: { mode: AccessMode; models: string[] }) => void }) {
  const dashboardApi = useDashboardApi();
  const [mode, setMode] = useState<AccessMode>(initialMode);
  const [selected, setSelected] = useState<Set<string>>(new Set(initialModels));
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const save = async (nextMode: AccessMode, nextModels: Set<string>) => {
    if (readonly) return;
    setIsLoading(true);
    setErrorMessage("");
    try {
      const result = await dashboardApi.apiKeys.updateModelAccess({ id: apiKeyId, mode: nextMode, models: [...nextModels] });
      if (!result.success) throw new Error(result.error);
      setMode(result.data.mode);
      setSelected(new Set(result.data.models));
      onUpdated(result.data);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to update model access");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <AccessModeSelector mode={mode} disabled={readonly || isLoading} onModeChange={(next) => void save(next, selected)} />
      {mode !== "all" ? (
        <>
          <div className="flex flex-wrap gap-1">
            {availableModels.slice(0, 200).map((model) => {
              const active = selected.has(model.id);
              return (
                <button
                  key={model.id}
                  type="button"
                  disabled={readonly || isLoading}
                  className={cn(
                    "inline-flex h-6 cursor-pointer items-center rounded border px-2 font-mono text-[10px] transition-colors disabled:cursor-default disabled:opacity-50",
                    active ? "border-primary/35 bg-primary/10 text-primary" : "border-border/70 text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => {
                    const next = new Set(selected);
                    if (active) next.delete(model.id);
                    else next.add(model.id);
                    void save(mode, next);
                  }}
                >
                  {model.id}
                </button>
              );
            })}
          </div>
          {selected.size > 0 ? <p className="text-[11px] text-muted-foreground">{selected.size} model{selected.size === 1 ? "" : "s"} selected</p> : null}
        </>
      ) : null}
      {errorMessage ? <p className="text-xs text-destructive">{errorMessage}</p> : null}
    </div>
  );
}

function ApiKeyAccountAccess({ apiKeyId, availableAccounts, initialMode, initialAccounts, readonly, onUpdated }: { apiKeyId: string; availableAccounts: Array<{ id: string; name: string }>; initialMode: AccessMode; initialAccounts: string[]; readonly: boolean; onUpdated: (value: { mode: AccessMode; accounts: string[] }) => void }) {
  const dashboardApi = useDashboardApi();
  const [mode, setMode] = useState<AccessMode>(initialMode);
  const [selected, setSelected] = useState<Set<string>>(new Set(initialAccounts));
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const save = async (nextMode: AccessMode, nextAccounts: Set<string>) => {
    if (readonly) return;
    setIsLoading(true);
    setErrorMessage("");
    try {
      const result = await dashboardApi.apiKeys.updateAccountAccess({ id: apiKeyId, mode: nextMode, accounts: [...nextAccounts] });
      if (!result.success) throw new Error(result.error);
      setMode(result.data.mode);
      setSelected(new Set(result.data.accounts));
      onUpdated(result.data);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to update account access");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <AccessModeSelector mode={mode} disabled={readonly || isLoading} onModeChange={(next) => void save(next, selected)} />
      {mode !== "all" ? (
        <>
          <div className="flex flex-wrap gap-1">
            {availableAccounts.map((account) => {
              const active = selected.has(account.id);
              return (
                <button
                  key={account.id}
                  type="button"
                  disabled={readonly || isLoading}
                  className={cn(
                    "inline-flex h-6 cursor-pointer items-center rounded border px-2 text-[10px] transition-colors disabled:cursor-default disabled:opacity-50",
                    active ? "border-primary/35 bg-primary/10 text-primary" : "border-border/70 text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => {
                    const next = new Set(selected);
                    if (active) next.delete(account.id);
                    else next.add(account.id);
                    void save(mode, next);
                  }}
                >
                  {account.name}
                </button>
              );
            })}
          </div>
          {selected.size > 0 ? <p className="text-[11px] text-muted-foreground">{selected.size} account{selected.size === 1 ? "" : "s"} selected</p> : null}
        </>
      ) : null}
      {errorMessage ? <p className="text-xs text-destructive">{errorMessage}</p> : null}
    </div>
  );
}

function ApiKeyRateLimit({ apiKeyId, availableModels, availableFamilies, initialRules, readonly, onUpdated }: { apiKeyId: string; availableModels: Array<{ id: string; label: string }>; availableFamilies: string[]; initialRules: RateLimitRule[]; readonly: boolean; onUpdated: (rules: RateLimitRule[]) => void }) {
  const dashboardApi = useDashboardApi();
  const [rules, setRules] = useState<RateLimitRule[]>(initialRules);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [draft, setDraft] = useState<RateLimitRule>({ target: availableModels[0]?.id ?? "", targetType: "model", perMinute: null, perHour: null, perDay: null });

  const save = async (nextRules: RateLimitRule[]) => {
    if (readonly) return;
    setIsLoading(true);
    setErrorMessage("");
    try {
      const result = await dashboardApi.apiKeys.updateRateLimits({ id: apiKeyId, rules: nextRules });
      if (!result.success) throw new Error(result.error);
      setRules(result.data.rules);
      onUpdated(result.data.rules);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to update rate limits");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      {rules.length > 0 ? (
        <div className="space-y-1">
          {rules.map((rule) => (
            <div key={`${rule.targetType}:${rule.target}`} className="flex items-center justify-between gap-2 rounded border border-border/70 px-2 py-1 text-[11px]">
              <span className="min-w-0 truncate font-mono text-muted-foreground">
                {rule.targetType === "family" ? `family:${rule.target}` : rule.target}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {rule.perMinute ? `${rule.perMinute}/min ` : ""}{rule.perHour ? `${rule.perHour}/hr ` : ""}{rule.perDay ? `${rule.perDay}/day` : ""}
              </span>
              <button
                type="button"
                disabled={readonly || isLoading}
                className="shrink-0 cursor-pointer text-muted-foreground transition-colors hover:text-destructive disabled:cursor-default disabled:opacity-50"
                aria-label="Remove rate limit"
                onClick={() => void save(rules.filter((r) => !(r.targetType === rule.targetType && r.target === rule.target)))}
              >
                <UiIcon name="i-lucide-x" className="size-3" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">No rate limits. Requests are unlimited.</p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          value={draft.targetType}
          disabled={readonly || isLoading}
          onChange={(event) => setDraft({ ...draft, targetType: event.target.value as "model" | "family", target: "" })}
          className="h-7 rounded border border-input bg-background px-2 text-[11px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <option value="model">Model</option>
          <option value="family">Family</option>
        </select>
        <select
          value={draft.target}
          disabled={readonly || isLoading}
          onChange={(event) => setDraft({ ...draft, target: event.target.value })}
          className="h-7 max-w-40 rounded border border-input bg-background px-2 font-mono text-[11px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {(draft.targetType === "model" ? availableModels : availableFamilies.map((f) => ({ id: f, label: f }))).map((item) => (
            <option key={item.id} value={item.id}>{item.id}</option>
          ))}
        </select>
        {(["perMinute", "perHour", "perDay"] as const).map((key) => (
          <input
            key={key}
            type="number"
            min={1}
            placeholder={key.replace("per", "")}
            value={draft[key] ?? ""}
            disabled={readonly || isLoading}
            onChange={(event) => setDraft({ ...draft, [key]: event.target.value ? Number(event.target.value) : null })}
            className="h-7 w-16 rounded border border-input bg-background px-2 text-[11px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
        ))}
        <UiButton
          size="xs"
          variant="outline"
          disabled={readonly || isLoading || !draft.target || (!draft.perMinute && !draft.perHour && !draft.perDay)}
          onClick={() => void save([...rules, { ...draft, perMinute: draft.perMinute ?? null, perHour: draft.perHour ?? null, perDay: draft.perDay ?? null }])}
        >
          Add
        </UiButton>
      </div>
      {errorMessage ? <p className="text-xs text-destructive">{errorMessage}</p> : null}
    </div>
  );
}

export default function ApiKeysPage() {
  const dashboardApi = useDashboardApi();
  const { isAuditMode } = useDashboardAudit();
  const { data, error, refresh } = useDashboardData<{ apiKeys: ApiKeyListItem[]; options: ApiKeyOptions }>(dashboardDataKeys.apiKeys, async () => {
    const [apiKeys, options] = await Promise.all([dashboardApi.apiKeys.list(), dashboardApi.apiKeys.options()]);
    return { apiKeys, options };
  }, { enabled: true });

  const apiKeys = data?.apiKeys ?? [];
  const options = data?.options ?? null;
  const activeApiKeyCount = apiKeys.filter((apiKey) => getApiKeyStatus(apiKey).label === "Active").length;
  const [copiedProxyBaseUrl, setCopiedProxyBaseUrl] = useState(false);
  const [togglingApiKeyIds, setTogglingApiKeyIds] = useState<Set<string>>(new Set());
  const [toggleErrors, setToggleErrors] = useState<Record<string, string>>({});
  const [roamingUpdatingIds, setRoamingUpdatingIds] = useState<Set<string>>(new Set());
  const [roamingErrors, setRoamingErrors] = useState<Record<string, string>>({});

  const copyProxyBaseUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(PROXY_BASE_URL);
      setCopiedProxyBaseUrl(true);
      window.setTimeout(() => setCopiedProxyBaseUrl(false), 1800);
    } catch {
      console.error("Failed to copy proxy base URL");
    }
  }, []);

  const toggleApiKey = async (apiKey: ApiKeyListItem) => {
    if (isAuditMode || togglingApiKeyIds.has(apiKey.id)) return;
    setTogglingApiKeyIds((current) => new Set(current).add(apiKey.id));
    setToggleErrors((current) => ({ ...current, [apiKey.id]: "" }));
    try {
      const result = await dashboardApi.apiKeys.toggle({ id: apiKey.id });
      if (!result.success) throw new Error(result.error);
      await refresh();
    } catch (error) {
      setToggleErrors((current) => ({ ...current, [apiKey.id]: error instanceof Error ? error.message : "Failed to toggle API key" }));
    } finally {
      setTogglingApiKeyIds((current) => {
        const next = new Set(current);
        next.delete(apiKey.id);
        return next;
      });
    }
  };

  const toggleRoaming = async (apiKey: ApiKeyListItem, enabled: boolean) => {
    if (isAuditMode || roamingUpdatingIds.has(apiKey.id)) return;
    setRoamingUpdatingIds((current) => new Set(current).add(apiKey.id));
    setRoamingErrors((current) => ({ ...current, [apiKey.id]: "" }));
    try {
      const result = await dashboardApi.apiKeys.updateRoaming({ id: apiKey.id, enabled });
      if (!result.success) throw new Error(result.error);
      await refresh();
    } catch (error) {
      setRoamingErrors((current) => ({ ...current, [apiKey.id]: error instanceof Error ? error.message : "Failed to update roaming" }));
    } finally {
      setRoamingUpdatingIds((current) => {
        const next = new Set(current);
        next.delete(apiKey.id);
        return next;
      });
    }
  };

  const availableModels = useMemo(() => (options?.availableModels ?? []).map((m) => ({ id: m, label: m })), [options]);
  const availableAccounts = options?.providerAccounts ?? [];
  const availableFamilies = options?.availableFamilies ?? [];

  const updatePatch = (apiKeyId: string, value: Partial<ApiKeyListItem>) => {
    if (!data) return;
    // handled via refresh on next invalidation
    void refresh();
  };

  return (
    <div className="space-y-6">
      <div className="dashboard-header-divider">
        <div className="flex min-h-9 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="inline-flex min-h-9 items-center gap-2 text-xl font-semibold">
            API Keys
            {apiKeys.length > 0 ? <UiBadge variant="outline" className="text-xs">{activeApiKeyCount}/{apiKeys.length}</UiBadge> : null}
          </h2>
          <div className="flex w-full items-center sm:w-auto">
            <CreateApiKeyButton readonly={isAuditMode} onCreated={() => void refresh()} />
          </div>
        </div>
      </div>

      <DashboardDataNotice error={error} />

      <UiCard className="bg-card">
        <UiCardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium">Proxy Base URL</p>
            <code className="block break-all text-sm text-muted-foreground">{PROXY_BASE_URL}</code>
          </div>
          <UiButton type="button" variant="outline" className="shrink-0" onClick={() => void copyProxyBaseUrl()}>
            <UiIcon name={copiedProxyBaseUrl ? "i-lucide-check" : "i-lucide-copy"} className="size-4" />
            {copiedProxyBaseUrl ? "Copied" : "Copy"}
          </UiButton>
        </UiCardContent>
      </UiCard>

      {apiKeys.length > 0 ? (
        <section className="scroll-mt-24 space-y-4 md:space-y-2">
          <div className="dashboard-card-grid">
            {apiKeys.map((apiKey) => {
              const status = getApiKeyStatus(apiKey);
              const keyRateLimits = options?.rateLimitsByKeyId[apiKey.id] ?? [];
              return (
                <UiCard key={apiKey.id} className={cn("flex h-full flex-col bg-transparent transition-colors", status.label !== "Active" && "opacity-65")}>
                  <UiCardHeader className="pb-1">
                    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                      <div className="min-w-0 overflow-hidden">
                        <p className="truncate text-sm font-medium">{apiKey.name || "Untitled key"}</p>
                      </div>
                      <div className="flex h-7 shrink-0 items-center justify-end gap-1.5">
                        <span className="text-[11px] leading-none text-muted-foreground">{status.label === "Active" ? "On" : "Off"}</span>
                        <UiSwitch
                          checked={status.label === "Active"}
                          disabled={togglingApiKeyIds.has(apiKey.id) || isAuditMode}
                          title={status.label === "Active" ? "Disable" : "Enable"}
                          onCheckedChange={() => void toggleApiKey(apiKey)}
                        />
                      </div>
                    </div>
                    {toggleErrors[apiKey.id] ? <p className="mt-1 text-xs text-destructive">{toggleErrors[apiKey.id]}</p> : null}
                  </UiCardHeader>

                  <UiCardContent className="flex flex-1 flex-col pt-0">
                    <div className="flex-1 space-y-3 text-sm">
                      <ApiKeyActions apiKey={apiKey} readonly={isAuditMode} onDeleted={() => void refresh()} onRenamed={() => void refresh()} />

                      <div className="space-y-2 pt-2">
                        <div className="flex items-center justify-between gap-4">
                          <span className="text-muted-foreground">Expiration</span>
                          <div className="text-right">
                            <ApiKeyExpiration apiKeyId={apiKey.id} initialExpiresAt={apiKey.expiresAt} readonly={isAuditMode} onUpdated={() => void refresh()} />
                          </div>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span className="text-muted-foreground">Last used</span>
                          <span className="text-right font-medium">{apiKey.lastUsedAt ? formatRelativeTime(apiKey.lastUsedAt) : "-"}</span>
                        </div>
                        <div className="flex items-center justify-between gap-4">
                          <span className="flex items-center gap-1.5 text-muted-foreground">
                            Roaming
                            <UiIcon name="i-lucide-circle-question-mark" className="size-3 [stroke-width:1.5] text-muted-foreground/60" />
                          </span>
                          <div className="flex items-center gap-1.5">
                            {apiKey.roamingEnabled ? (
                              <span className="flex items-center gap-1 text-[11px] leading-none text-foreground">
                                <UiIcon name="i-lucide-coins" className="size-3" />
                                <span className="tabular-nums">{apiKey.roamingPointsUsed.toLocaleString("en-US")}</span>
                              </span>
                            ) : null}
                            <UiSwitch checked={apiKey.roamingEnabled} size="sm" title={apiKey.roamingEnabled ? "Disable" : "Enable"} disabled={isAuditMode || roamingUpdatingIds.has(apiKey.id)} onCheckedChange={(value) => void toggleRoaming(apiKey, value)} />
                          </div>
                        </div>
                        {roamingErrors[apiKey.id] ? <p className="text-right text-xs text-destructive">{roamingErrors[apiKey.id]}</p> : null}
                      </div>

                      <div className="grid gap-2.5 border-t border-border/60 pt-3">
                        <ApiKeyAccessSection title="Model Access" badge={normalizeMode(apiKey.modelAccessMode) === "all" ? undefined : normalizeMode(apiKey.modelAccessMode)}>
                          <ApiKeyModelAccess
                            apiKeyId={apiKey.id}
                            availableModels={availableModels}
                            initialMode={normalizeMode(apiKey.modelAccessMode)}
                            initialModels={apiKey.modelAccessList}
                            readonly={isAuditMode}
                            onUpdated={() => void refresh()}
                          />
                        </ApiKeyAccessSection>
                        <ApiKeyAccessSection title="Account Access" badge={normalizeMode(apiKey.accountAccessMode) === "all" ? undefined : normalizeMode(apiKey.accountAccessMode)}>
                          <ApiKeyAccountAccess
                            apiKeyId={apiKey.id}
                            availableAccounts={availableAccounts}
                            initialMode={normalizeMode(apiKey.accountAccessMode)}
                            initialAccounts={apiKey.accountAccessList}
                            readonly={isAuditMode}
                            onUpdated={() => void refresh()}
                          />
                        </ApiKeyAccessSection>
                        <ApiKeyAccessSection title="Rate Limits" badge={keyRateLimits.length > 0 ? `${keyRateLimits.length} limit${keyRateLimits.length === 1 ? "" : "s"}` : undefined}>
                          <ApiKeyRateLimit
                            apiKeyId={apiKey.id}
                            availableModels={availableModels}
                            availableFamilies={availableFamilies}
                            initialRules={keyRateLimits}
                            readonly={isAuditMode}
                            onUpdated={() => void refresh()}
                          />
                        </ApiKeyAccessSection>
                      </div>
                    </div>
                  </UiCardContent>
                </UiCard>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}
