"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  AlertCircle,
  BarChart3,
  Check,
  CheckCircle,
  Copy,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  getAntigravityQuota,
  type AccountQuotaInfo as AntigravityAccountQuotaInfo,
  type QuotaGroupDisplay as AntigravityQuotaGroupDisplay,
} from "@/lib/actions/antigravity-quota";
import {
  getCopilotQuota,
  type CopilotAccountQuotaInfo,
  type CopilotQuotaGroupDisplay,
} from "@/lib/actions/copilot-quota";
import {
  getCodexQuota,
  type CodexAccountQuotaInfo,
  type CodexQuotaGroupDisplay,
} from "@/lib/actions/codex-quota";
import {
  getGeminiCliQuota,
  type GeminiCliAccountQuotaInfo,
  type GeminiCliQuotaGroupDisplay,
} from "@/lib/actions/gemini-cli-quota";
import {
  getKiroQuota,
  type KiroAccountQuotaInfo,
  type KiroQuotaGroupDisplay,
} from "@/lib/actions/kiro-quota";
import {
  getOpenRouterQuota,
  type OpenRouterAccountQuotaInfo,
  type OpenRouterQuotaGroupDisplay,
} from "@/lib/actions/openrouter-quota";
import {
  getProviderAccountErrorHistory,
  resolveProviderAccountErrors,
  updateProviderAccount,
  type ProviderAccountErrorHistoryEntry,
} from "@/lib/actions/accounts";
import { formatRelativeTime } from "@/lib/date";
import { toast } from "sonner";
import { AccountActions } from "./account-actions";
import { UsageSparkline } from "@/components/dashboard/shared/usage-sparkline";
import { PROVIDER_ACCOUNTS_REFRESH_EVENT } from "./constants";
import { setAccountModelEnabled } from "@/lib/actions/account-models";
import type { ProviderAccountKey } from "@/lib/provider-accounts";

type AccountQuotaInfo =
  | AntigravityAccountQuotaInfo
  | CopilotAccountQuotaInfo
  | CodexAccountQuotaInfo
  | GeminiCliAccountQuotaInfo
  | KiroAccountQuotaInfo
  | OpenRouterAccountQuotaInfo;
type QuotaGroupDisplay =
  | AntigravityQuotaGroupDisplay
  | CopilotQuotaGroupDisplay
  | CodexQuotaGroupDisplay
  | GeminiCliQuotaGroupDisplay
  | KiroQuotaGroupDisplay
  | OpenRouterQuotaGroupDisplay;

interface Account {
  id: string;
  name: string;
  provider: string;
  email: string | null;
  isActive: boolean;
  requestCount: number;
  lastUsedAt: Date | null;
  expiresAt: Date;
  tier: string | null;
  // Error tracking fields
  status: string;
  errorCount: number;
  consecutiveErrors: number;
  lastErrorAt: Date | null;
  lastErrorMessage: string | null;
  lastErrorCode: number | null;
  successCount: number;
  lastSuccessAt: Date | null;
  stats: {
    totalRequests: number;
    successRate: number | null;
    dailyRequests: Array<{ date: string; count: number }>;
  };
}

interface AccountsListProps {
  antigravityAccounts: Account[];
  iflowAccounts: Account[];
  geminiCliAccounts: Account[];
  qwenCodeAccounts: Account[];
  copilotAccounts: Account[];
  codexAccounts: Account[];
  kiroAccounts: Account[];
  nvidiaNimAccounts: Account[];
  ollamaCloudAccounts: Account[];
  openRouterAccounts: Account[];
  visibleProviders?: ProviderAccountKey[];
  supportedModelsByProvider?: Partial<Record<ProviderAccountKey, string[]>>;
  disabledModelsByAccountId?: Record<string, string[]>;
}

function formatTierLabel(tier: string): string {
  const normalized = tier.trim().toLowerCase();

  switch (normalized) {
    case "free":
      return "Free";
    case "plus":
      return "Plus";
    case "pro":
      return "Pro";
    case "team":
      return "Team";
    case "go":
      return "Go";
    case "business":
      return "Business";
    case "enterprise":
      return "Enterprise";
    case "edu":
    case "education":
      return "Edu";
    case "paid":
    case "standard-tier":
      return "Paid";
    default:
      return normalized
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => part[0].toUpperCase() + part.slice(1))
        .join(" ");
  }
}

function isPaidTierValue(tier: string): boolean {
  const normalized = tier.trim().toLowerCase();
  return ["paid", "standard-tier", "plus", "pro", "team", "go", "business", "enterprise", "edu", "education"].includes(
    normalized
  );
}

function getAccountHeader(account: Account): { title: string; subtitle: string | null } {
  const rawName = account.name.trim();
  const rawEmail = account.email?.trim() ?? "";

  if (!rawEmail) {
    return { title: rawName, subtitle: null };
  }

  const normalizedEmail = rawEmail.toLowerCase();
  let title = rawName;

  const trailingEmailMatch = title.match(/\(([^)]+)\)\s*$/);
  if (trailingEmailMatch?.[1]?.trim().toLowerCase() === normalizedEmail) {
    title = title.replace(/\([^)]+\)\s*$/, "").trim();
  }

  if (!title) {
    title = rawEmail;
  }

  if (title.toLowerCase().includes(normalizedEmail)) {
    return { title, subtitle: null };
  }

  return { title, subtitle: rawEmail };
}

function StatusBadge({ status, consecutiveErrors }: { status: string; consecutiveErrors: number }) {
  if (status === "failed") {
    return (
      <Badge variant="destructive" className="gap-1">
        <AlertCircle className="h-3 w-3" />
        Failed
      </Badge>
    );
  }
  if (status === "degraded") {
    return (
      <Badge variant="outline" className="border-yellow-500 text-yellow-600 gap-1">
        <AlertTriangle className="h-3 w-3" />
        Degraded ({consecutiveErrors})
      </Badge>
    );
  }
  return null;
}

function QuotaGroupBar({ group }: { group: QuotaGroupDisplay }) {
  const percentRemaining = Math.max(0, Math.min(100, Math.round(group.remainingFraction * 100)));
  const customRemainingLabel =
    "remainingLabel" in group && typeof group.remainingLabel === "string"
      ? group.remainingLabel
      : null;
  const remainingLabel =
    customRemainingLabel ??
    (group.models.length === 0
      ? `${percentRemaining}%`
      : `${group.remainingRequests}/${group.maxRequests}`);
  let resetTitle: string | undefined;

  if (group.resetTimeIso) {
    const resetDate = new Date(group.resetTimeIso);
    if (!Number.isNaN(resetDate.getTime())) {
      resetTitle = resetDate.toLocaleString();
    }
  }

  let barColor = "bg-green-500";
  let textColor = "text-green-600 dark:text-green-400";

  if (percentRemaining <= 10) {
    barColor = "bg-red-500";
    textColor = "text-red-600 dark:text-red-400";
  } else if (percentRemaining <= 25) {
    barColor = "bg-orange-500";
    textColor = "text-orange-600 dark:text-orange-400";
  } else if (percentRemaining <= 50) {
    barColor = "bg-yellow-500";
    textColor = "text-yellow-600 dark:text-yellow-400";
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="min-w-0 text-muted-foreground truncate">{group.displayName}</span>
        <span className="flex items-center gap-2">
          {group.resetInHuman && (
            <span className="text-[10px] text-muted-foreground" title={resetTitle}>
              {group.resetInHuman}
            </span>
          )}
          <span className={`font-mono ${textColor}`}>{remainingLabel}</span>
        </span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full ${barColor} transition-all duration-300`}
          style={{ width: `${percentRemaining}%` }}
        />
      </div>
    </div>
  );
}

function LastErrorMessageDialog({
  accountId,
  message,
  code,
  occurredAt,
  tone = "error",
}: {
  accountId: string;
  message: string;
  code: number | null;
  occurredAt: Date | null;
  tone?: "error" | "warning";
}) {
  type ParsedErrorDetails = {
    error: string | null;
    provider: string | null;
    endpoint: string | null;
    model: string | null;
    parameters: string | null;
    messageObjects: string[] | null;
  };

  const parseStoredErrorMessage = (rawMessage: string): ParsedErrorDetails => {
    const sections: Record<string, string[]> = {
      error: [],
      provider: [],
      endpoint: [],
      model: [],
      parameters: [],
      messages: [],
    };

    const labels: Array<{ key: keyof typeof sections; prefix: string }> = [
      { key: "error", prefix: "Error:" },
      { key: "provider", prefix: "Provider:" },
      { key: "endpoint", prefix: "Endpoint:" },
      { key: "model", prefix: "Model:" },
      { key: "parameters", prefix: "Parameters:" },
      { key: "messages", prefix: "Messages (object keys only):" },
    ];

    let currentKey: keyof typeof sections | null = null;

    for (const line of rawMessage.split("\n")) {
      const matchedLabel = labels.find((label) => line.startsWith(label.prefix));
      if (matchedLabel) {
        currentKey = matchedLabel.key;
        const initialValue = line.slice(matchedLabel.prefix.length).trimStart();
        if (initialValue) {
          sections[currentKey].push(initialValue);
        }
        continue;
      }

      if (currentKey) {
        sections[currentKey].push(line);
      }
    }

    const parsedMessageObjects = (() => {
      const rawMessages = sections.messages.join("\n").trim();
      if (!rawMessages) {
        return null;
      }

      try {
        const parsed = JSON.parse(rawMessages) as Array<{
          index?: number;
          keys?: unknown;
          type?: unknown;
        }>;

        if (!Array.isArray(parsed)) {
          return null;
        }

        return parsed.map((entry, fallbackIndex) => {
          const entryIndex = typeof entry.index === "number" ? entry.index : fallbackIndex;
          if (Array.isArray(entry.keys)) {
            const normalizedKeys = entry.keys.filter((value): value is string => typeof value === "string");
            return `#${entryIndex}: ${normalizedKeys.length > 0 ? normalizedKeys.join(", ") : "(no keys)"}`;
          }

          if (typeof entry.type === "string") {
            return `#${entryIndex}: (${entry.type})`;
          }

          return `#${entryIndex}: (unknown)`;
        });
      } catch {
        return rawMessages
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
      }
    })();

    return {
      error: sections.error.join("\n").trim() || null,
      provider: sections.provider.join("\n").trim() || null,
      endpoint: sections.endpoint.join("\n").trim() || null,
      model: sections.model.join("\n").trim() || null,
      parameters: sections.parameters.join("\n").trim() || null,
      messageObjects: parsedMessageObjects,
    };
  };

  const [copied, setCopied] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyEntries, setHistoryEntries] = useState<ProviderAccountErrorHistoryEntry[] | null>(null);
  const historyRequestIdRef = useRef(0);
  const preview = message.length > 150 ? `${message.slice(0, 150)}...` : message;
  const previewColorClass =
    tone === "warning" ? "text-amber-600 dark:text-amber-400" : "text-red-500";
  const details = parseStoredErrorMessage(message);

  useEffect(() => {
    if (!isOpen || historyEntries !== null) {
      return;
    }

    const requestId = ++historyRequestIdRef.current;

    void getProviderAccountErrorHistory(accountId)
      .then((result) => {
        if (requestId !== historyRequestIdRef.current) {
          return;
        }

        if (!result.success) {
          setHistoryError(result.error);
          setHistoryEntries([]);
          return;
        }

        setHistoryEntries(result.data.entries);
      })
      .catch(() => {
        if (requestId !== historyRequestIdRef.current) {
          return;
        }

        setHistoryError("Failed to load error history");
        setHistoryEntries([]);
      })
      .finally(() => {
        if (requestId === historyRequestIdRef.current) {
          setIsHistoryLoading(false);
        }
      });
  }, [accountId, historyEntries, isOpen]);

  const handleDialogOpenChange = (open: boolean) => {
    setIsOpen(open);

    if (open && historyEntries === null) {
      setIsHistoryLoading(true);
      setHistoryError(null);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      toast.success("Error details copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Failed to copy error details");
    }
  };

  const handleResolve = async () => {
    setIsResolving(true);
    try {
      const result = await resolveProviderAccountErrors(accountId);
      if (!result.success) {
        throw new Error(result.error);
      }
      toast.success("Account errors resolved");
      setIsOpen(false);
      window.dispatchEvent(new CustomEvent(PROVIDER_ACCOUNTS_REFRESH_EVENT));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to resolve errors");
    } finally {
      setIsResolving(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleDialogOpenChange}>
      <DialogTrigger asChild>
         <button
          type="button"
          className="w-full min-h-[3.25rem] rounded-sm pt-2 text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="text-muted-foreground text-xs">Last Error Message:</span>
          <span className={`mt-1 block text-xs line-clamp-2 break-all ${previewColorClass}`}>
            {code && `[${code}] `}
            {preview}
          </span>
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <DialogTitle>Provider Error Details</DialogTitle>
              <DialogDescription>
                {code ? `HTTP ${code}` : "No status code"}
                {occurredAt ? ` - ${formatRelativeTime(occurredAt)}` : ""}
              </DialogDescription>
            </div>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label="Copy error details"
                onClick={handleCopy}
                title="Copy error details"
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label="Resolve errors"
                onClick={handleResolve}
                disabled={isResolving}
                title="Resolve — clear all errors and error history for this account"
              >
                <CheckCircle className="h-4 w-4 text-green-600" />
              </Button>
            </div>
          </div>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-3 overflow-y-auto rounded-md border bg-muted/20 p-3">
          {(details.provider || details.endpoint || details.model) && (
            <div className="rounded-md border bg-background/70 p-2">
              {details.provider && (
                <p className="text-xs">
                  <span className="text-muted-foreground">Provider:</span>{" "}
                  <span className="font-mono">{details.provider}</span>
                </p>
              )}
              {details.endpoint && (
                <p className="text-xs">
                  <span className="text-muted-foreground">Endpoint:</span>{" "}
                  <span className="font-mono">{details.endpoint}</span>
                </p>
              )}
              {details.model && (
                <p className="text-xs">
                  <span className="text-muted-foreground">Model:</span>{" "}
                  <span className="font-mono">{details.model}</span>
                </p>
              )}
            </div>
          )}

          {details.error && (
            <div>
              <p className="mb-1 text-xs text-muted-foreground">Error</p>
              <p className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
                {details.error}
              </p>
            </div>
          )}

          {details.parameters && (
            <div>
              <p className="mb-1 text-xs text-muted-foreground">Body Parameters</p>
              <p className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
                {details.parameters}
              </p>
            </div>
          )}

          {details.messageObjects && details.messageObjects.length > 0 && (
            <div>
              <p className="mb-1 text-xs text-muted-foreground">Messages (object keys only)</p>
              <p className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
                {details.messageObjects.join("\n")}
              </p>
            </div>
          )}

          {!details.error && !details.parameters && (!details.messageObjects || details.messageObjects.length === 0) && (
            <p className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
              {message}
            </p>
          )}

          <div className="border-t pt-3">
            <p className="mb-2 text-xs text-muted-foreground">Recent Error History (up to 200)</p>

            {isHistoryLoading && (
              <p className="text-xs text-muted-foreground">Loading error history...</p>
            )}

            {!isHistoryLoading && historyError && (
              <p className="text-xs text-red-500">{historyError}</p>
            )}

            {!isHistoryLoading && !historyError && historyEntries && historyEntries.length > 0 && (
              <div className="space-y-2">
                {historyEntries.map((entry) => {
                  const createdAt = new Date(entry.createdAt);
                  const relativeTime = Number.isNaN(createdAt.getTime())
                    ? "Unknown time"
                    : formatRelativeTime(createdAt);
                  const codeLabel = `HTTP ${entry.errorCode}`;
                  const previewText =
                    entry.errorMessage.length > 120
                      ? `${entry.errorMessage.slice(0, 120)}...`
                      : entry.errorMessage;

                  return (
                    <details key={entry.id} className="rounded-md border bg-background/70 p-2">
                      <summary className="cursor-pointer break-words text-xs text-foreground">
                        <span className="font-medium">{relativeTime}</span>
                        <span className="mx-1 text-muted-foreground">-</span>
                        <span className="font-mono text-[11px] text-muted-foreground">{codeLabel}</span>
                        <span className="mx-1 text-muted-foreground">-</span>
                        <span className="text-muted-foreground">{previewText}</span>
                      </summary>
                      <p className="mt-2 whitespace-pre-wrap break-words font-mono text-xs text-foreground">
                        {entry.errorMessage}
                      </p>
                    </details>
                  );
                })}
              </div>
            )}

            {!isHistoryLoading && !historyError && historyEntries && historyEntries.length === 0 && (
              <p className="text-xs text-muted-foreground">No stored error history for this account yet.</p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AccountModelAccess({
  accountId,
  supportedModels,
  initialDisabledModels,
}: {
  accountId: string;
  supportedModels: string[];
  initialDisabledModels: string[];
}) {
  const [disabledModels, setDisabledModels] = useState<Set<string>>(
    () => new Set(initialDisabledModels)
  );
  const [togglingModels, setTogglingModels] = useState<Set<string>>(new Set());

  const enabledCount = supportedModels.length - disabledModels.size;

  const handleToggleModel = async (model: string) => {
    const currentlyEnabled = !disabledModels.has(model);
    const newEnabled = !currentlyEnabled;

    setTogglingModels((prev) => new Set(prev).add(model));

    // Optimistic update
    setDisabledModels((prev) => {
      const next = new Set(prev);
      if (newEnabled) {
        next.delete(model);
      } else {
        next.add(model);
      }
      return next;
    });

    try {
      const result = await setAccountModelEnabled(accountId, model, newEnabled);
      if (!result.success) {
        // Revert optimistic update
        setDisabledModels((prev) => {
          const reverted = new Set(prev);
          if (newEnabled) {
            reverted.add(model);
          } else {
            reverted.delete(model);
          }
          return reverted;
        });
        toast.error(result.error);
      }
    } catch {
      // Revert on network error
      setDisabledModels((prev) => {
        const reverted = new Set(prev);
        if (newEnabled) {
          reverted.add(model);
        } else {
          reverted.delete(model);
        }
        return reverted;
      });
      toast.error("Failed to update model");
    } finally {
      setTogglingModels((prev) => {
        const next = new Set(prev);
        next.delete(model);
        return next;
      });
    }
  };

  if (supportedModels.length === 0) {
    return null;
  }

  return (
    <div className="pt-3 mt-3 border-t space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">Model Access</span>
        <span className="text-xs text-muted-foreground">
          {enabledCount}/{supportedModels.length}
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {supportedModels.map((model) => {
          const isEnabled = !disabledModels.has(model);
          const isToggling = togglingModels.has(model);

          return (
            <button
              key={model}
              type="button"
              onClick={() => handleToggleModel(model)}
              disabled={isToggling}
              title={isEnabled ? `Disable ${model}` : `Enable ${model}`}
              className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed ${
                isEnabled
                  ? "border-primary/40 bg-primary/10 text-foreground"
                  : "border-border bg-transparent text-muted-foreground line-through"
              }`}
            >
              {model}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AccountCard({ 
  account, 
  showTier = false,
  quotaInfo,
  isQuotaLoading = false,
  supportedModels,
  disabledModels,
}: { 
  account: Account;
  showTier?: boolean;
  quotaInfo?: AccountQuotaInfo;
  isQuotaLoading?: boolean;
  supportedModels?: string[];
  disabledModels?: string[];
}) {
  const hasErrors = account.errorCount > 0;
  const supportsQuotaMonitor =
    account.provider === "antigravity" ||
    account.provider === "copilot" ||
    account.provider === "codex" ||
    account.provider === "gemini_cli" ||
    account.provider === "kiro" ||
    account.provider === "openrouter";
  const dailyValues = account.stats.dailyRequests.map((point) => point.count);
  const peakRequests = Math.max(...dailyValues, 0);
  const weeklySuccessRate = account.stats.successRate;
  const { title, subtitle } = getAccountHeader(account);
  const effectiveTier =
    account.provider === "codex" ? (quotaInfo?.tier ?? account.tier) : account.tier;
  const normalizedTier = effectiveTier?.trim().toLowerCase() ?? null;
  const isPaidTier = normalizedTier ? isPaidTierValue(normalizedTier) : false;
  const tierLabel = normalizedTier ? formatTierLabel(normalizedTier) : null;
  const showTierBadge =
    showTier && Boolean(tierLabel) && normalizedTier !== "unknown" && normalizedTier !== "guest";
  const hasSuccessAfterLastError = Boolean(
    account.lastErrorAt &&
      account.lastSuccessAt &&
      account.lastSuccessAt.getTime() > account.lastErrorAt.getTime()
  );
  const errorToneClass = hasSuccessAfterLastError
    ? "text-amber-600 dark:text-amber-400"
    : "text-red-500";
  const errorCountToneClass = hasErrors ? errorToneClass : "text-muted-foreground";
  const lastErrorToneClass = account.lastErrorAt ? errorToneClass : "text-muted-foreground";
  const [isToggling, setIsToggling] = useState(false);

  const handleToggleActive = async () => {
    setIsToggling(true);
    try {
      const result = await updateProviderAccount(account.id, { isActive: !account.isActive });
      if (!result.success) {
        throw new Error(result.error);
      }
      toast.success(`Account ${account.isActive ? "disabled" : "enabled"}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update account");
    } finally {
      setIsToggling(false);
    }
  };

  return (
    <Card className={`bg-card h-full flex flex-col ${!account.isActive ? "opacity-65" : ""}`}>
      <CardHeader className="pb-2">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <CardTitle className="min-w-0 truncate text-lg">{title}</CardTitle>
          <div className="flex gap-1 flex-wrap justify-end">
            {showTierBadge && tierLabel && (
              <Badge 
                variant="outline" 
                className={isPaidTier ? "border-green-500 text-green-600" : ""}
              >
                {tierLabel}
              </Badge>
            )}
            {account.status !== "active" && (
              <StatusBadge status={account.status} consecutiveErrors={account.consecutiveErrors} />
            )}
          </div>
        </div>
        {subtitle && <CardDescription>{subtitle}</CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        <div className="space-y-2 text-sm flex-1">
          <div className="mb-3 rounded-md border border-border/70 bg-muted/20 p-2.5">
            <div className="mb-2 flex items-center justify-between text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <BarChart3 className="h-3 w-3" />
                Last 30 days
              </span>
              <span>{peakRequests.toLocaleString()} peak/day</span>
            </div>

            <div className="mb-2 grid grid-cols-2 gap-2">
              <div className="rounded border border-border/60 bg-background/70 px-2 py-1.5">
                <p className="text-[10px] text-muted-foreground">Requests</p>
                <p className="text-sm font-semibold text-foreground">
                  {account.stats.totalRequests.toLocaleString()}
                </p>
              </div>
              <div className="rounded border border-border/60 bg-background/70 px-2 py-1.5">
                <p className="text-[10px] text-muted-foreground">Success</p>
                <p className="text-sm font-semibold text-foreground">
                  {weeklySuccessRate === null ? "-" : `${weeklySuccessRate}%`}
                </p>
              </div>
            </div>

            <UsageSparkline
              values={dailyValues}
              color="var(--chart-2)"
              ariaLabel={`Requests trend for ${title}`}
            />
          </div>

          <div className="flex justify-between">
            <span className="text-muted-foreground">Last used</span>
            <span className="font-medium">
              {account.lastUsedAt
                ? formatRelativeTime(account.lastUsedAt)
                : "Never"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Total Errors</span>
            <span className={`font-medium ${errorCountToneClass}`}>{account.errorCount}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Last Error</span>
            <span className={`font-medium ${lastErrorToneClass}`}>
              {account.lastErrorAt ? formatRelativeTime(account.lastErrorAt) : "-"}
            </span>
          </div>
          <div className="min-h-14 border-t">
            {account.lastErrorMessage ? (
              <LastErrorMessageDialog
                accountId={account.id}
                message={account.lastErrorMessage}
                code={account.lastErrorCode}
                occurredAt={account.lastErrorAt}
                tone={hasSuccessAfterLastError ? "warning" : "error"}
              />
            ) : (
              <div className="w-full min-h-[3.25rem] rounded-sm pt-2 text-left">
                <span className="text-muted-foreground text-xs">Last Error Message:</span>
                <span className="text-muted-foreground mt-1 block text-xs line-clamp-2 break-all">-</span>
              </div>
            )}
          </div>

          {supportsQuotaMonitor && (
            <div className="pt-3 mt-3 border-t space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground">Quota</span>
                {quotaInfo?.status === "success" && quotaInfo.groups.some((group) => group.isEstimated) && (
                  <Badge variant="outline" className="text-[10px] px-1 py-0">
                    estimated
                  </Badge>
                )}
              </div>

              {isQuotaLoading && !quotaInfo ? (
                <div className="space-y-2">
                  <Skeleton className="h-1.5 w-full rounded-full" />
                  <Skeleton className="h-1.5 w-full rounded-full" />
                </div>
              ) : !quotaInfo ? (
                <p className="text-xs text-muted-foreground">Quota data is not available yet.</p>
              ) : quotaInfo.status === "success" && quotaInfo.groups.length > 0 ? (
                <div className="space-y-2">
                  {quotaInfo.groups.map((group) => (
                    <QuotaGroupBar key={group.name} group={group} />
                  ))}
                </div>
              ) : (
                <p className="text-xs text-red-500">{quotaInfo.error ?? "Failed to fetch quota data."}</p>
              )}
            </div>
          )}

          {supportedModels && supportedModels.length > 0 && (
            <AccountModelAccess
              accountId={account.id}
              supportedModels={supportedModels}
              initialDisabledModels={disabledModels ?? []}
            />
          )}
        </div>
        <div className="mt-4 flex items-center justify-between gap-2">
          <AccountActions account={account} />
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-[11px] text-muted-foreground">
              {account.isActive ? "On" : "Off"}
            </span>
            <Switch
              checked={account.isActive}
              onCheckedChange={handleToggleActive}
              disabled={isToggling}
              title={account.isActive ? "Disable account" : "Enable account"}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

interface ProviderSectionProps {
  id: string;
  title: string;
  accounts: Account[];
  showTier?: boolean;
  emptyMessage: string;
  supportedModels?: string[];
  quotaByAccountId?: Record<string, AccountQuotaInfo>;
  isQuotaLoading?: boolean;
  hideHeader?: boolean;
  disabledModelsByAccountId?: Record<string, string[]>;
}

function ProviderSection({
  id,
  title,
  accounts,
  showTier = false,
  emptyMessage,
  supportedModels,
  quotaByAccountId,
  isQuotaLoading = false,
  hideHeader = false,
  disabledModelsByAccountId,
}: ProviderSectionProps) {
  return (
    <section id={id} className="scroll-mt-24 space-y-4 md:space-y-2">
      {!hideHeader && (
        <div className="flex items-center gap-2">
          <h3 className="text-base md:text-lg font-semibold">{title}</h3>
          <Badge variant="outline" className="text-xs">
            {accounts.length} connected
          </Badge>
        </div>
      )}

      <div className="pt-1">
        {accounts.length > 0 ? (
          <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {accounts.map((account) => (
              <AccountCard
                key={account.id}
                account={account}
                showTier={showTier}
                quotaInfo={quotaByAccountId?.[account.id]}
                isQuotaLoading={isQuotaLoading}
                supportedModels={supportedModels}
                disabledModels={disabledModelsByAccountId?.[account.id]}
              />
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{emptyMessage}</p>
            {supportedModels && supportedModels.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">
                  Supported models ({supportedModels.length}):
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {supportedModels.map((model) => (
                    <Badge key={model} variant="secondary" className="text-xs font-normal">
                      {model}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

export function AccountsList({
  antigravityAccounts,
  iflowAccounts,
  geminiCliAccounts,
  qwenCodeAccounts,
  copilotAccounts,
  codexAccounts,
  kiroAccounts,
  nvidiaNimAccounts,
  ollamaCloudAccounts,
  openRouterAccounts,
  visibleProviders,
  supportedModelsByProvider,
  disabledModelsByAccountId,
}: AccountsListProps) {
  const [antigravityQuotaByAccountId, setAntigravityQuotaByAccountId] =
    useState<Record<string, AccountQuotaInfo>>({});
  const [codexQuotaByAccountId, setCodexQuotaByAccountId] =
    useState<Record<string, AccountQuotaInfo>>({});
  const [copilotQuotaByAccountId, setCopilotQuotaByAccountId] =
    useState<Record<string, AccountQuotaInfo>>({});
  const [geminiCliQuotaByAccountId, setGeminiCliQuotaByAccountId] =
    useState<Record<string, AccountQuotaInfo>>({});
  const [kiroQuotaByAccountId, setKiroQuotaByAccountId] =
    useState<Record<string, AccountQuotaInfo>>({});
  const [openRouterQuotaByAccountId, setOpenRouterQuotaByAccountId] =
    useState<Record<string, AccountQuotaInfo>>({});
  const [isAntigravityQuotaLoading, setIsAntigravityQuotaLoading] = useState(false);
  const [isCodexQuotaLoading, setIsCodexQuotaLoading] = useState(false);
  const [isCopilotQuotaLoading, setIsCopilotQuotaLoading] = useState(false);
  const [isGeminiCliQuotaLoading, setIsGeminiCliQuotaLoading] = useState(false);
  const [isKiroQuotaLoading, setIsKiroQuotaLoading] = useState(false);
  const [isOpenRouterQuotaLoading, setIsOpenRouterQuotaLoading] = useState(false);
  const quotaRequestIdsRef = useRef({
    antigravity: 0,
    codex: 0,
    copilot: 0,
    geminiCli: 0,
    kiro: 0,
    openRouter: 0,
  });

  const fetchAntigravityQuota = useCallback(async (forceRefresh = false) => {
    if (antigravityAccounts.length === 0) {
      quotaRequestIdsRef.current.antigravity += 1;
      setAntigravityQuotaByAccountId({});
      setIsAntigravityQuotaLoading(false);
      return;
    }

    const requestId = ++quotaRequestIdsRef.current.antigravity;
    setIsAntigravityQuotaLoading(true);

    try {
      const result = await getAntigravityQuota({ forceRefresh });
      if (requestId !== quotaRequestIdsRef.current.antigravity) {
        return;
      }

      if (!result.success) {
        setAntigravityQuotaByAccountId({});
        return;
      }

      const quotaMap = result.data.accounts.reduce<Record<string, AccountQuotaInfo>>(
        (accumulator, accountQuota) => {
          accumulator[accountQuota.accountId] = accountQuota;
          return accumulator;
        },
        {}
      );

      setAntigravityQuotaByAccountId(quotaMap);
    } finally {
      if (requestId === quotaRequestIdsRef.current.antigravity) {
        setIsAntigravityQuotaLoading(false);
      }
    }
  }, [antigravityAccounts.length]);

  const fetchCodexQuota = useCallback(async (forceRefresh = false) => {
    if (codexAccounts.length === 0) {
      quotaRequestIdsRef.current.codex += 1;
      setCodexQuotaByAccountId({});
      setIsCodexQuotaLoading(false);
      return;
    }

    const requestId = ++quotaRequestIdsRef.current.codex;
    setIsCodexQuotaLoading(true);

    try {
      const result = await getCodexQuota({ forceRefresh });
      if (requestId !== quotaRequestIdsRef.current.codex) {
        return;
      }

      if (!result.success) {
        setCodexQuotaByAccountId({});
        return;
      }

      const quotaMap = result.data.accounts.reduce<Record<string, AccountQuotaInfo>>(
        (accumulator, accountQuota) => {
          accumulator[accountQuota.accountId] = accountQuota;
          return accumulator;
        },
        {}
      );

      setCodexQuotaByAccountId(quotaMap);
    } finally {
      if (requestId === quotaRequestIdsRef.current.codex) {
        setIsCodexQuotaLoading(false);
      }
    }
  }, [codexAccounts.length]);

  const fetchCopilotQuota = useCallback(async (forceRefresh = false) => {
    if (copilotAccounts.length === 0) {
      quotaRequestIdsRef.current.copilot += 1;
      setCopilotQuotaByAccountId({});
      setIsCopilotQuotaLoading(false);
      return;
    }

    const requestId = ++quotaRequestIdsRef.current.copilot;
    setIsCopilotQuotaLoading(true);

    try {
      const result = await getCopilotQuota({ forceRefresh });
      if (requestId !== quotaRequestIdsRef.current.copilot) {
        return;
      }

      if (!result.success) {
        setCopilotQuotaByAccountId({});
        return;
      }

      const quotaMap = result.data.accounts.reduce<Record<string, AccountQuotaInfo>>(
        (accumulator, accountQuota) => {
          accumulator[accountQuota.accountId] = accountQuota;
          return accumulator;
        },
        {}
      );

      setCopilotQuotaByAccountId(quotaMap);
    } finally {
      if (requestId === quotaRequestIdsRef.current.copilot) {
        setIsCopilotQuotaLoading(false);
      }
    }
  }, [copilotAccounts.length]);

  const fetchGeminiCliQuota = useCallback(async (forceRefresh = false) => {
    if (geminiCliAccounts.length === 0) {
      quotaRequestIdsRef.current.geminiCli += 1;
      setGeminiCliQuotaByAccountId({});
      setIsGeminiCliQuotaLoading(false);
      return;
    }

    const requestId = ++quotaRequestIdsRef.current.geminiCli;
    setIsGeminiCliQuotaLoading(true);

    try {
      const result = await getGeminiCliQuota({ forceRefresh });
      if (requestId !== quotaRequestIdsRef.current.geminiCli) {
        return;
      }

      if (!result.success) {
        setGeminiCliQuotaByAccountId({});
        return;
      }

      const quotaMap = result.data.accounts.reduce<Record<string, AccountQuotaInfo>>(
        (accumulator, accountQuota) => {
          accumulator[accountQuota.accountId] = accountQuota;
          return accumulator;
        },
        {}
      );

      setGeminiCliQuotaByAccountId(quotaMap);
    } finally {
      if (requestId === quotaRequestIdsRef.current.geminiCli) {
        setIsGeminiCliQuotaLoading(false);
      }
    }
  }, [geminiCliAccounts.length]);

  const fetchOpenRouterQuota = useCallback(async (forceRefresh = false) => {
    if (openRouterAccounts.length === 0) {
      quotaRequestIdsRef.current.openRouter += 1;
      setOpenRouterQuotaByAccountId({});
      setIsOpenRouterQuotaLoading(false);
      return;
    }

    const requestId = ++quotaRequestIdsRef.current.openRouter;
    setIsOpenRouterQuotaLoading(true);

    try {
      const result = await getOpenRouterQuota({ forceRefresh });
      if (requestId !== quotaRequestIdsRef.current.openRouter) {
        return;
      }

      if (!result.success) {
        setOpenRouterQuotaByAccountId({});
        return;
      }

      const quotaMap = result.data.accounts.reduce<Record<string, AccountQuotaInfo>>(
        (accumulator, accountQuota) => {
          accumulator[accountQuota.accountId] = accountQuota;
          return accumulator;
        },
        {}
      );

      setOpenRouterQuotaByAccountId(quotaMap);
    } finally {
      if (requestId === quotaRequestIdsRef.current.openRouter) {
        setIsOpenRouterQuotaLoading(false);
      }
    }
  }, [openRouterAccounts.length]);

  const fetchKiroQuota = useCallback(async (forceRefresh = false) => {
    if (kiroAccounts.length === 0) {
      quotaRequestIdsRef.current.kiro += 1;
      setKiroQuotaByAccountId({});
      setIsKiroQuotaLoading(false);
      return;
    }

    const requestId = ++quotaRequestIdsRef.current.kiro;
    setIsKiroQuotaLoading(true);

    try {
      const result = await getKiroQuota({ forceRefresh });
      if (requestId !== quotaRequestIdsRef.current.kiro) {
        return;
      }

      if (!result.success) {
        setKiroQuotaByAccountId({});
        return;
      }

      const quotaMap = result.data.accounts.reduce<Record<string, AccountQuotaInfo>>(
        (accumulator, accountQuota) => {
          accumulator[accountQuota.accountId] = accountQuota;
          return accumulator;
        },
        {}
      );

      setKiroQuotaByAccountId(quotaMap);
    } finally {
      if (requestId === quotaRequestIdsRef.current.kiro) {
        setIsKiroQuotaLoading(false);
      }
    }
  }, [kiroAccounts.length]);

  useEffect(() => {
    void fetchAntigravityQuota();
  }, [fetchAntigravityQuota]);

  useEffect(() => {
    void fetchCodexQuota();
  }, [fetchCodexQuota]);

  useEffect(() => {
    void fetchCopilotQuota();
  }, [fetchCopilotQuota]);

  useEffect(() => {
    void fetchGeminiCliQuota();
  }, [fetchGeminiCliQuota]);

  useEffect(() => {
    void fetchOpenRouterQuota();
  }, [fetchOpenRouterQuota]);

  useEffect(() => {
    void fetchKiroQuota();
  }, [fetchKiroQuota]);

  useEffect(() => {
    const handleProviderAccountsRefresh = () => {
      void fetchAntigravityQuota(true);
      void fetchCodexQuota(true);
      void fetchCopilotQuota(true);
      void fetchGeminiCliQuota(true);
      void fetchKiroQuota(true);
      void fetchOpenRouterQuota(true);
    };

    window.addEventListener(PROVIDER_ACCOUNTS_REFRESH_EVENT, handleProviderAccountsRefresh);

    return () => {
      window.removeEventListener(PROVIDER_ACCOUNTS_REFRESH_EVENT, handleProviderAccountsRefresh);
    };
  }, [
    fetchAntigravityQuota,
    fetchCodexQuota,
    fetchCopilotQuota,
    fetchGeminiCliQuota,
    fetchKiroQuota,
    fetchOpenRouterQuota,
  ]);

  const visibleProviderSet =
    visibleProviders && visibleProviders.length > 0
      ? new Set<ProviderAccountKey>(visibleProviders)
      : null;
  const hasProviderFilter = visibleProviderSet !== null;
  const shouldRenderProvider = (provider: ProviderAccountKey) =>
    visibleProviderSet === null || visibleProviderSet.has(provider);

  const oauthProviderSections: ReactNode[] = [];
  if (shouldRenderProvider("antigravity")) {
    oauthProviderSections.push(
      <ProviderSection
        key="antigravity"
        id="antigravity-accounts"
        title="Antigravity Accounts"
        hideHeader={hasProviderFilter}
        accounts={antigravityAccounts}
        showTier
        emptyMessage="No Antigravity accounts connected yet."
        supportedModels={supportedModelsByProvider?.antigravity}
        quotaByAccountId={antigravityQuotaByAccountId}
        isQuotaLoading={isAntigravityQuotaLoading}
        disabledModelsByAccountId={disabledModelsByAccountId}
      />
    );
  }
  if (shouldRenderProvider("codex")) {
    oauthProviderSections.push(
      <ProviderSection
        key="codex"
        id="codex-accounts"
        title="Codex Accounts"
        hideHeader={hasProviderFilter}
        accounts={codexAccounts}
        showTier
        emptyMessage="No Codex accounts connected yet."
        supportedModels={supportedModelsByProvider?.codex}
        quotaByAccountId={codexQuotaByAccountId}
        isQuotaLoading={isCodexQuotaLoading}
        disabledModelsByAccountId={disabledModelsByAccountId}
      />
    );
  }
  if (shouldRenderProvider("iflow")) {
    oauthProviderSections.push(
      <ProviderSection
        key="iflow"
        id="iflow-accounts"
        title="Iflow Accounts"
        hideHeader={hasProviderFilter}
        accounts={iflowAccounts}
        emptyMessage="No Iflow accounts connected yet."
        supportedModels={supportedModelsByProvider?.iflow}
        disabledModelsByAccountId={disabledModelsByAccountId}
      />
    );
  }
  if (shouldRenderProvider("kiro")) {
    oauthProviderSections.push(
      <ProviderSection
        key="kiro"
        id="kiro-accounts"
        title="Kiro Accounts"
        hideHeader={hasProviderFilter}
        accounts={kiroAccounts}
        emptyMessage="No Kiro accounts connected yet."
        supportedModels={supportedModelsByProvider?.kiro}
        quotaByAccountId={kiroQuotaByAccountId}
        isQuotaLoading={isKiroQuotaLoading}
        disabledModelsByAccountId={disabledModelsByAccountId}
      />
    );
  }
  if (shouldRenderProvider("gemini_cli")) {
    oauthProviderSections.push(
      <ProviderSection
        key="gemini-cli"
        id="gemini-cli-accounts"
        title="Gemini CLI Accounts"
        hideHeader={hasProviderFilter}
        accounts={geminiCliAccounts}
        showTier
        emptyMessage="No Gemini CLI accounts connected yet."
        supportedModels={supportedModelsByProvider?.gemini_cli}
        quotaByAccountId={geminiCliQuotaByAccountId}
        isQuotaLoading={isGeminiCliQuotaLoading}
        disabledModelsByAccountId={disabledModelsByAccountId}
      />
    );
  }
  if (shouldRenderProvider("qwen_code")) {
    oauthProviderSections.push(
      <ProviderSection
        key="qwen-code"
        id="qwen-code-accounts"
        title="Qwen Code Accounts"
        hideHeader={hasProviderFilter}
        accounts={qwenCodeAccounts}
        emptyMessage="No Qwen Code accounts connected yet."
        supportedModels={supportedModelsByProvider?.qwen_code}
        disabledModelsByAccountId={disabledModelsByAccountId}
      />
    );
  }
  if (shouldRenderProvider("copilot")) {
    oauthProviderSections.push(
      <ProviderSection
        key="copilot"
        id="copilot-accounts"
        title="Copilot Accounts"
        hideHeader={hasProviderFilter}
        accounts={copilotAccounts}
        emptyMessage="No Copilot accounts connected yet."
        supportedModels={supportedModelsByProvider?.copilot}
        quotaByAccountId={copilotQuotaByAccountId}
        isQuotaLoading={isCopilotQuotaLoading}
        disabledModelsByAccountId={disabledModelsByAccountId}
      />
    );
  }

  const apiKeyProviderSections: ReactNode[] = [];
  if (shouldRenderProvider("nvidia_nim")) {
    apiKeyProviderSections.push(
      <ProviderSection
        key="nvidia-nim"
        id="nvidia-nim-accounts"
        title="Nvidia Accounts"
        hideHeader={hasProviderFilter}
        accounts={nvidiaNimAccounts}
        emptyMessage="No Nvidia accounts connected yet."
        supportedModels={supportedModelsByProvider?.nvidia_nim}
        disabledModelsByAccountId={disabledModelsByAccountId}
      />
    );
  }
  if (shouldRenderProvider("ollama_cloud")) {
    apiKeyProviderSections.push(
      <ProviderSection
        key="ollama-cloud"
        id="ollama-cloud-accounts"
        title="Ollama Cloud Accounts"
        hideHeader={hasProviderFilter}
        accounts={ollamaCloudAccounts}
        emptyMessage="No Ollama Cloud accounts connected yet."
        supportedModels={supportedModelsByProvider?.ollama_cloud}
        disabledModelsByAccountId={disabledModelsByAccountId}
      />
    );
  }
  if (shouldRenderProvider("openrouter")) {
    apiKeyProviderSections.push(
      <ProviderSection
        key="openrouter"
        id="openrouter-accounts"
        title="OpenRouter Accounts"
        hideHeader={hasProviderFilter}
        accounts={openRouterAccounts}
        emptyMessage="No OpenRouter accounts connected yet."
        supportedModels={supportedModelsByProvider?.openrouter}
        quotaByAccountId={openRouterQuotaByAccountId}
        isQuotaLoading={isOpenRouterQuotaLoading}
        disabledModelsByAccountId={disabledModelsByAccountId}
      />
    );
  }

  if (hasProviderFilter) {
    return <div className="space-y-6">{[...oauthProviderSections, ...apiKeyProviderSections]}</div>;
  }

  return (
    <div className="space-y-8">
      <section id="oauth-provider-accounts" className="space-y-5 md:space-y-3">
        <div className="space-y-1">
          <h3 className="text-base font-semibold">OAuth Provider Accounts</h3>
        </div>

        <div className="space-y-6">{oauthProviderSections}</div>
      </section>

      <section id="api-key-provider-accounts" className="space-y-5 md:space-y-3">
        <div className="space-y-1">
          <h3 className="text-base font-semibold">API Key Provider Accounts</h3>
        </div>

        <div className="space-y-6">{apiKeyProviderSections}</div>
      </section>
    </div>
  );
}
