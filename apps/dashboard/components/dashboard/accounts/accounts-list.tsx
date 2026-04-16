"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  AlertCircle,
  BarChart3,
  Check,
  CheckCircle,
  ClipboardList,
  Copy,
  FlaskConical,
  RefreshCw,
  Pin,
  PinOff,
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
import { usePlaygroundPreset } from "@/lib/playground-preset-context";
import { togglePinnedProvider } from "@/lib/actions/pinned-providers";

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
  geminiCliAccounts: Account[];
  qwenCodeAccounts: Account[];
  copilotAccounts: Account[];
  codexAccounts: Account[];
  kiroAccounts: Account[];
  nvidiaNimAccounts: Account[];
  ollamaCloudAccounts: Account[];
  openRouterAccounts: Account[];
  groqAccounts: Account[];
  cerebrasAccounts: Account[];
  kiloCodeAccounts: Account[];
  workersAiAccounts: Account[];
  visibleProviders?: ProviderAccountKey[];
  supportedModelsByProvider?: Partial<Record<ProviderAccountKey, string[]>>;
  disabledModelsByAccountId?: Record<string, string[]>;
  pinnedProviders: ProviderAccountKey[];
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

  const [copiedAll, setCopiedAll] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Failed to copy error details");
    }
  };

  const handleCopyAll = async () => {
    try {
      const parts: string[] = [`[Current Error]\n${message}`];
      if (historyEntries && historyEntries.length > 0) {
        for (const entry of historyEntries) {
          parts.push(`[${entry.errorCode ? `HTTP ${entry.errorCode}` : "No code"} - ${new Date(entry.createdAt).toLocaleString()}]\n${entry.errorMessage}`);
        }
      }
      await navigator.clipboard.writeText(parts.join("\n\n---\n\n"));
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1500);
    } catch {
      toast.error("Failed to copy all errors");
    }
  };

  const handleResolve = async () => {
    setIsResolving(true);
    try {
      const result = await resolveProviderAccountErrors(accountId);
      if (!result.success) {
        throw new Error(result.error);
      }
      setIsOpen(false);
      window.dispatchEvent(new CustomEvent(PROVIDER_ACCOUNTS_REFRESH_EVENT));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to resolve errors");
    } finally {
      setIsResolving(false);
    }
  };

  const [copiedPreview, setCopiedPreview] = useState(false);

  const handleCopyPreview = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(message);
      setCopiedPreview(true);
      setTimeout(() => setCopiedPreview(false), 1500);
    } catch {
      toast.error("Failed to copy error details");
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleDialogOpenChange}>
      <DialogTrigger asChild>
         <button
          type="button"
          className="w-full min-h-[3.25rem] rounded-sm pt-2 text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex items-center justify-between gap-1">
            <span className="text-muted-foreground text-xs">Last Error Message:</span>
            <button
              type="button"
              className="shrink-0 p-0.5 rounded hover:bg-muted transition-colors cursor-pointer"
              aria-label="Copy last error message"
              title="Copy last error message"
              onClick={handleCopyPreview}
            >
              {copiedPreview ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
            </button>
          </div>
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
                aria-label="Copy all errors"
                onClick={handleCopyAll}
                title="Copy all errors (current + history)"
              >
                {copiedAll ? <Check className="h-4 w-4" /> : <ClipboardList className="h-4 w-4" />}
              </Button>
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
                    <ErrorHistoryEntry
                      key={entry.id}
                      relativeTime={relativeTime}
                      codeLabel={codeLabel}
                      previewText={previewText}
                      errorMessage={entry.errorMessage}
                    />
                  );
                })}
              </div>
            )}

            {!isHistoryLoading && !historyError && historyEntries && historyEntries.length === 0 && (
               <p className="text-xs text-muted-foreground">No stored error history yet.</p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ErrorHistoryEntry({
  relativeTime,
  codeLabel,
  previewText,
  errorMessage,
}: {
  relativeTime: string;
  codeLabel: string;
  previewText: string;
  errorMessage: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(errorMessage);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  };

  return (
    <details className="rounded-md border bg-background/70 p-2">
      <summary className="cursor-pointer break-words text-xs text-foreground">
        <span className="font-medium">{relativeTime}</span>
        <span className="mx-1 text-muted-foreground">-</span>
        <span className="font-mono text-[11px] text-muted-foreground">{codeLabel}</span>
        <span className="mx-1 text-muted-foreground">-</span>
        <span className="text-muted-foreground">{previewText}</span>
      </summary>
      <div className="mt-2 flex items-start gap-2">
        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-xs text-foreground">
          {errorMessage}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          aria-label="Copy error message"
          onClick={handleCopy}
          title="Copy error message"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </details>
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

  const [expanded, setExpanded] = useState(false);
  const VISIBLE_COUNT = 5;
  const hasMore = supportedModels.length > VISIBLE_COUNT;
  const visibleModels = expanded ? supportedModels : supportedModels.slice(0, VISIBLE_COUNT);
  const hiddenCount = supportedModels.length - VISIBLE_COUNT;

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
        {visibleModels.map((model) => {
          const isEnabled = !disabledModels.has(model);
          const isToggling = togglingModels.has(model);

          return (
            <button
              key={model}
              type="button"
              onClick={() => handleToggleModel(model)}
              disabled={isToggling}
              title={isEnabled ? `Disable ${model}` : `Enable ${model}`}
              className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-mono transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed ${
                isEnabled
                  ? "bg-muted text-foreground"
                  : "bg-transparent text-muted-foreground/60 line-through"
              }`}
            >
              {model}
            </button>
          );
        })}
        {hasMore && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {expanded ? "Show less" : `+${hiddenCount} more`}
          </button>
        )}
      </div>
    </div>
  );
}

function AccountCard({ 
  account, 
  showTier = false,
  quotaInfo,
  isQuotaLoading = false,
  onRefreshQuota,
  supportedModels,
  disabledModels,
}: { 
  account: Account;
  showTier?: boolean;
  quotaInfo?: AccountQuotaInfo;
  isQuotaLoading?: boolean;
  onRefreshQuota?: (accountId: string) => void;
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
  const router = useRouter();
  const { setPreset } = usePlaygroundPreset();

  const handleOpenPlayground = () => {
    setPreset({ accountId: account.id });
    router.push("/dashboard/playground");
  };

  const handleToggleActive = async () => {
    setIsToggling(true);
    try {
      const result = await updateProviderAccount(account.id, { isActive: !account.isActive });
      if (!result.success) {
        throw new Error(result.error);
      }
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
                <div className="flex items-center gap-1.5">
                  {quotaInfo?.status === "success" && quotaInfo.groups.some((group) => group.isEstimated) && (
                    <Badge variant="outline" className="text-[10px] px-1 py-0">
                      estimated
                    </Badge>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => onRefreshQuota?.(account.id)}
                    disabled={isQuotaLoading || !onRefreshQuota}
                    title="Refresh quota"
                    aria-label={`Refresh quota for ${title}`}
                  >
                    <RefreshCw className={cn("h-3.5 w-3.5", isQuotaLoading && "animate-spin")} />
                  </Button>
                </div>
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
          <div className="flex items-center gap-2">
            <AccountActions account={account} />
            {account.isActive && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                title="Open in Playground"
                onClick={handleOpenPlayground}
              >
                <FlaskConical className="h-3 w-3" />
              </Button>
            )}
          </div>
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
  providerKey: ProviderAccountKey;
  title: string;
  accounts: Account[];
  showTier?: boolean;
  emptyMessage: string;
  supportedModels?: string[];
  quotaByAccountId?: Record<string, AccountQuotaInfo>;
  isQuotaLoading?: boolean;
  hideHeader?: boolean;
  disabledModelsByAccountId?: Record<string, string[]>;
  isPinned: boolean;
  onTogglePin: (providerKey: ProviderAccountKey) => void;
  onRefreshQuota?: (accountId: string) => void;
  quotaLoadingAccountIds?: Set<string>;
}

function ProviderSection({
  id,
  providerKey,
  title,
  accounts,
  showTier = false,
  emptyMessage,
  supportedModels,
  quotaByAccountId,
  isQuotaLoading = false,
  hideHeader = false,
  disabledModelsByAccountId,
  isPinned,
  onTogglePin,
  onRefreshQuota,
  quotaLoadingAccountIds,
}: ProviderSectionProps) {
  return (
    <section id={id} className="scroll-mt-24 space-y-4 md:space-y-2">
      {!hideHeader && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onTogglePin(providerKey)}
            className={cn(
              "p-1 rounded-md transition-colors cursor-pointer",
              isPinned
                ? "text-foreground hover:text-muted-foreground"
                : "text-muted-foreground/40 hover:text-muted-foreground"
            )}
            title={isPinned ? "Unpin from sidebar" : "Pin to sidebar"}
          >
            {isPinned ? <Pin className="h-4 w-4" /> : <PinOff className="h-4 w-4" />}
          </button>
          <h3 className="text-base md:text-lg font-semibold">{title}</h3>
          <Badge variant="outline" className="text-xs">
            {accounts.length} connected
          </Badge>
        </div>
      )}

      <div className="pt-1">
        {accounts.length > 0 ? (
           <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
            {accounts.map((account) => (
              <AccountCard
                key={account.id}
                account={account}
                showTier={showTier}
                quotaInfo={quotaByAccountId?.[account.id]}
                isQuotaLoading={isQuotaLoading || quotaLoadingAccountIds?.has(account.id) === true}
                onRefreshQuota={onRefreshQuota}
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
  geminiCliAccounts,
  qwenCodeAccounts,
  copilotAccounts,
  codexAccounts,
  kiroAccounts,
  nvidiaNimAccounts,
  ollamaCloudAccounts,
  openRouterAccounts,
  groqAccounts,
  cerebrasAccounts,
  kiloCodeAccounts,
  workersAiAccounts,
  visibleProviders,
  supportedModelsByProvider,
  disabledModelsByAccountId,
  pinnedProviders,
}: AccountsListProps) {
  const [pinnedSet, setPinnedSet] = useState<Set<ProviderAccountKey>>(
    () => new Set(pinnedProviders)
  );

  const handleTogglePin = useCallback(async (providerKey: ProviderAccountKey) => {
    const wasPinned = pinnedSet.has(providerKey);
    setPinnedSet((prev) => {
      const next = new Set(prev);
      if (wasPinned) {
        next.delete(providerKey);
      } else {
        next.add(providerKey);
      }
      return next;
    });

    const result = await togglePinnedProvider(providerKey);
    if (!result.success) {
      setPinnedSet((prev) => {
        const reverted = new Set(prev);
        if (wasPinned) {
          reverted.add(providerKey);
        } else {
          reverted.delete(providerKey);
        }
        return reverted;
      });
      toast.error(result.error);
    }
  }, [pinnedSet]);

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
  const [quotaLoadingAccountIds, setQuotaLoadingAccountIds] = useState<Record<string, Set<string>>>(() => ({
    antigravity: new Set<string>(),
    codex: new Set<string>(),
    copilot: new Set<string>(),
    geminiCli: new Set<string>(),
    kiro: new Set<string>(),
    openRouter: new Set<string>(),
  }));
  const quotaRequestIdsRef = useRef({
    antigravity: 0,
    codex: 0,
    copilot: 0,
    geminiCli: 0,
    kiro: 0,
    openRouter: 0,
  });

  const setProviderQuotaAccountLoading = useCallback(
    (
      provider:
        | "antigravity"
        | "codex"
        | "copilot"
        | "geminiCli"
        | "kiro"
        | "openRouter",
      accountId: string,
      isLoading: boolean
    ) => {
      setQuotaLoadingAccountIds((prev) => {
        const current = prev[provider];
        const hasAccount = current.has(accountId);
        if ((isLoading && hasAccount) || (!isLoading && !hasAccount)) {
          return prev;
        }

        const next = new Set(current);
        if (isLoading) {
          next.add(accountId);
        } else {
          next.delete(accountId);
        }

        return {
          ...prev,
          [provider]: next,
        };
      });
    },
    []
  );

  const mergeQuotaResult = useCallback(
    (
      accountId: string | undefined,
      resultAccounts: AccountQuotaInfo[],
      setQuotaByAccountId: Dispatch<SetStateAction<Record<string, AccountQuotaInfo>>>
    ) => {
      const quotaMap = resultAccounts.reduce<Record<string, AccountQuotaInfo>>((accumulator, accountQuota) => {
        accumulator[accountQuota.accountId] = accountQuota;
        return accumulator;
      }, {});

      if (!accountId) {
        setQuotaByAccountId(quotaMap);
        return;
      }

      setQuotaByAccountId((prev) => {
        if (resultAccounts.length === 0) {
          if (!(accountId in prev)) {
            return prev;
          }

          const next = { ...prev };
          delete next[accountId];
          return next;
        }

        return {
          ...prev,
          ...quotaMap,
        };
      });
    },
    []
  );

  const fetchAntigravityQuota = useCallback(async (forceRefresh = false, accountId?: string) => {
    if (antigravityAccounts.length === 0) {
      quotaRequestIdsRef.current.antigravity += 1;
      setAntigravityQuotaByAccountId({});
      setIsAntigravityQuotaLoading(false);
      return;
    }

    const requestId = ++quotaRequestIdsRef.current.antigravity;
    if (accountId) {
      setProviderQuotaAccountLoading("antigravity", accountId, true);
    } else {
      setIsAntigravityQuotaLoading(true);
    }

    try {
      const result = await getAntigravityQuota({ forceRefresh, accountId });
      if (!accountId && requestId !== quotaRequestIdsRef.current.antigravity) {
        return;
      }

      if (!result.success) {
        if (!accountId) {
          setAntigravityQuotaByAccountId({});
        }
        return;
      }

      mergeQuotaResult(accountId, result.data.accounts, setAntigravityQuotaByAccountId);
    } finally {
      if (accountId) {
        setProviderQuotaAccountLoading("antigravity", accountId, false);
      } else if (requestId === quotaRequestIdsRef.current.antigravity) {
        setIsAntigravityQuotaLoading(false);
      }
    }
  }, [antigravityAccounts.length, mergeQuotaResult, setProviderQuotaAccountLoading]);

  const fetchCodexQuota = useCallback(async (forceRefresh = false, accountId?: string) => {
    if (codexAccounts.length === 0) {
      quotaRequestIdsRef.current.codex += 1;
      setCodexQuotaByAccountId({});
      setIsCodexQuotaLoading(false);
      return;
    }

    const requestId = ++quotaRequestIdsRef.current.codex;
    if (accountId) {
      setProviderQuotaAccountLoading("codex", accountId, true);
    } else {
      setIsCodexQuotaLoading(true);
    }

    try {
      const result = await getCodexQuota({ forceRefresh, accountId });
      if (!accountId && requestId !== quotaRequestIdsRef.current.codex) {
        return;
      }

      if (!result.success) {
        if (!accountId) {
          setCodexQuotaByAccountId({});
        }
        return;
      }

      mergeQuotaResult(accountId, result.data.accounts, setCodexQuotaByAccountId);
    } finally {
      if (accountId) {
        setProviderQuotaAccountLoading("codex", accountId, false);
      } else if (requestId === quotaRequestIdsRef.current.codex) {
        setIsCodexQuotaLoading(false);
      }
    }
  }, [codexAccounts.length, mergeQuotaResult, setProviderQuotaAccountLoading]);

  const fetchCopilotQuota = useCallback(async (forceRefresh = false, accountId?: string) => {
    if (copilotAccounts.length === 0) {
      quotaRequestIdsRef.current.copilot += 1;
      setCopilotQuotaByAccountId({});
      setIsCopilotQuotaLoading(false);
      return;
    }

    const requestId = ++quotaRequestIdsRef.current.copilot;
    if (accountId) {
      setProviderQuotaAccountLoading("copilot", accountId, true);
    } else {
      setIsCopilotQuotaLoading(true);
    }

    try {
      const result = await getCopilotQuota({ forceRefresh, accountId });
      if (!accountId && requestId !== quotaRequestIdsRef.current.copilot) {
        return;
      }

      if (!result.success) {
        if (!accountId) {
          setCopilotQuotaByAccountId({});
        }
        return;
      }

      mergeQuotaResult(accountId, result.data.accounts, setCopilotQuotaByAccountId);
    } finally {
      if (accountId) {
        setProviderQuotaAccountLoading("copilot", accountId, false);
      } else if (requestId === quotaRequestIdsRef.current.copilot) {
        setIsCopilotQuotaLoading(false);
      }
    }
  }, [copilotAccounts.length, mergeQuotaResult, setProviderQuotaAccountLoading]);

  const fetchGeminiCliQuota = useCallback(async (forceRefresh = false, accountId?: string) => {
    if (geminiCliAccounts.length === 0) {
      quotaRequestIdsRef.current.geminiCli += 1;
      setGeminiCliQuotaByAccountId({});
      setIsGeminiCliQuotaLoading(false);
      return;
    }

    const requestId = ++quotaRequestIdsRef.current.geminiCli;
    if (accountId) {
      setProviderQuotaAccountLoading("geminiCli", accountId, true);
    } else {
      setIsGeminiCliQuotaLoading(true);
    }

    try {
      const result = await getGeminiCliQuota({ forceRefresh, accountId });
      if (!accountId && requestId !== quotaRequestIdsRef.current.geminiCli) {
        return;
      }

      if (!result.success) {
        if (!accountId) {
          setGeminiCliQuotaByAccountId({});
        }
        return;
      }

      mergeQuotaResult(accountId, result.data.accounts, setGeminiCliQuotaByAccountId);
    } finally {
      if (accountId) {
        setProviderQuotaAccountLoading("geminiCli", accountId, false);
      } else if (requestId === quotaRequestIdsRef.current.geminiCli) {
        setIsGeminiCliQuotaLoading(false);
      }
    }
  }, [geminiCliAccounts.length, mergeQuotaResult, setProviderQuotaAccountLoading]);

  const fetchOpenRouterQuota = useCallback(async (forceRefresh = false, accountId?: string) => {
    if (openRouterAccounts.length === 0) {
      quotaRequestIdsRef.current.openRouter += 1;
      setOpenRouterQuotaByAccountId({});
      setIsOpenRouterQuotaLoading(false);
      return;
    }

    const requestId = ++quotaRequestIdsRef.current.openRouter;
    if (accountId) {
      setProviderQuotaAccountLoading("openRouter", accountId, true);
    } else {
      setIsOpenRouterQuotaLoading(true);
    }

    try {
      const result = await getOpenRouterQuota({ forceRefresh, accountId });
      if (!accountId && requestId !== quotaRequestIdsRef.current.openRouter) {
        return;
      }

      if (!result.success) {
        if (!accountId) {
          setOpenRouterQuotaByAccountId({});
        }
        return;
      }

      mergeQuotaResult(accountId, result.data.accounts, setOpenRouterQuotaByAccountId);
    } finally {
      if (accountId) {
        setProviderQuotaAccountLoading("openRouter", accountId, false);
      } else if (requestId === quotaRequestIdsRef.current.openRouter) {
        setIsOpenRouterQuotaLoading(false);
      }
    }
  }, [mergeQuotaResult, openRouterAccounts.length, setProviderQuotaAccountLoading]);

  const fetchKiroQuota = useCallback(async (forceRefresh = false, accountId?: string) => {
    if (kiroAccounts.length === 0) {
      quotaRequestIdsRef.current.kiro += 1;
      setKiroQuotaByAccountId({});
      setIsKiroQuotaLoading(false);
      return;
    }

    const requestId = ++quotaRequestIdsRef.current.kiro;
    if (accountId) {
      setProviderQuotaAccountLoading("kiro", accountId, true);
    } else {
      setIsKiroQuotaLoading(true);
    }

    try {
      const result = await getKiroQuota({ forceRefresh, accountId });
      if (!accountId && requestId !== quotaRequestIdsRef.current.kiro) {
        return;
      }

      if (!result.success) {
        if (!accountId) {
          setKiroQuotaByAccountId({});
        }
        return;
      }

      mergeQuotaResult(accountId, result.data.accounts, setKiroQuotaByAccountId);
    } finally {
      if (accountId) {
        setProviderQuotaAccountLoading("kiro", accountId, false);
      } else if (requestId === quotaRequestIdsRef.current.kiro) {
        setIsKiroQuotaLoading(false);
      }
    }
  }, [kiroAccounts.length, mergeQuotaResult, setProviderQuotaAccountLoading]);

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
        providerKey="antigravity"
        title="Antigravity"
        hideHeader={hasProviderFilter}
        accounts={antigravityAccounts}
        showTier
        emptyMessage="No Antigravity connections yet."
        supportedModels={supportedModelsByProvider?.antigravity}
        quotaByAccountId={antigravityQuotaByAccountId}
        isQuotaLoading={isAntigravityQuotaLoading}
        quotaLoadingAccountIds={quotaLoadingAccountIds.antigravity}
        onRefreshQuota={(accountId) => void fetchAntigravityQuota(true, accountId)}
        disabledModelsByAccountId={disabledModelsByAccountId}
        isPinned={pinnedSet.has("antigravity")}
        onTogglePin={handleTogglePin}
      />
    );
  }
  if (shouldRenderProvider("codex")) {
    oauthProviderSections.push(
      <ProviderSection
        key="codex"
        id="codex-accounts"
        providerKey="codex"
        title="Codex"
        hideHeader={hasProviderFilter}
        accounts={codexAccounts}
        showTier
        emptyMessage="No Codex connections yet."
        supportedModels={supportedModelsByProvider?.codex}
        quotaByAccountId={codexQuotaByAccountId}
        isQuotaLoading={isCodexQuotaLoading}
        quotaLoadingAccountIds={quotaLoadingAccountIds.codex}
        onRefreshQuota={(accountId) => void fetchCodexQuota(true, accountId)}
        disabledModelsByAccountId={disabledModelsByAccountId}
        isPinned={pinnedSet.has("codex")}
        onTogglePin={handleTogglePin}
      />
    );
  }
  if (shouldRenderProvider("kiro")) {
    oauthProviderSections.push(
      <ProviderSection
        key="kiro"
        id="kiro-accounts"
        providerKey="kiro"
        title="Kiro"
        hideHeader={hasProviderFilter}
        accounts={kiroAccounts}
        emptyMessage="No Kiro connections yet."
        supportedModels={supportedModelsByProvider?.kiro}
        quotaByAccountId={kiroQuotaByAccountId}
        isQuotaLoading={isKiroQuotaLoading}
        quotaLoadingAccountIds={quotaLoadingAccountIds.kiro}
        onRefreshQuota={(accountId) => void fetchKiroQuota(true, accountId)}
        disabledModelsByAccountId={disabledModelsByAccountId}
        isPinned={pinnedSet.has("kiro")}
        onTogglePin={handleTogglePin}
      />
    );
  }
  if (shouldRenderProvider("gemini_cli")) {
    oauthProviderSections.push(
      <ProviderSection
        key="gemini-cli"
        id="gemini-cli-accounts"
        providerKey="gemini_cli"
        title="Gemini CLI"
        hideHeader={hasProviderFilter}
        accounts={geminiCliAccounts}
        showTier
        emptyMessage="No Gemini CLI connections yet."
        supportedModels={supportedModelsByProvider?.gemini_cli}
        quotaByAccountId={geminiCliQuotaByAccountId}
        isQuotaLoading={isGeminiCliQuotaLoading}
        quotaLoadingAccountIds={quotaLoadingAccountIds.geminiCli}
        onRefreshQuota={(accountId) => void fetchGeminiCliQuota(true, accountId)}
        disabledModelsByAccountId={disabledModelsByAccountId}
        isPinned={pinnedSet.has("gemini_cli")}
        onTogglePin={handleTogglePin}
      />
    );
  }
  if (shouldRenderProvider("qwen_code")) {
    oauthProviderSections.push(
      <ProviderSection
        key="qwen-code"
        id="qwen-code-accounts"
        providerKey="qwen_code"
        title="Qwen Code"
        hideHeader={hasProviderFilter}
        accounts={qwenCodeAccounts}
        emptyMessage="No Qwen Code connections yet."
        supportedModels={supportedModelsByProvider?.qwen_code}
        disabledModelsByAccountId={disabledModelsByAccountId}
        isPinned={pinnedSet.has("qwen_code")}
        onTogglePin={handleTogglePin}
      />
    );
  }
  if (shouldRenderProvider("copilot")) {
    oauthProviderSections.push(
      <ProviderSection
        key="copilot"
        id="copilot-accounts"
        providerKey="copilot"
        title="Copilot"
        hideHeader={hasProviderFilter}
        accounts={copilotAccounts}
        emptyMessage="No Copilot connections yet."
        supportedModels={supportedModelsByProvider?.copilot}
        quotaByAccountId={copilotQuotaByAccountId}
        isQuotaLoading={isCopilotQuotaLoading}
        quotaLoadingAccountIds={quotaLoadingAccountIds.copilot}
        onRefreshQuota={(accountId) => void fetchCopilotQuota(true, accountId)}
        disabledModelsByAccountId={disabledModelsByAccountId}
        isPinned={pinnedSet.has("copilot")}
        onTogglePin={handleTogglePin}
      />
    );
  }

  const apiKeyProviderSections: ReactNode[] = [];
  if (shouldRenderProvider("nvidia_nim")) {
    apiKeyProviderSections.push(
      <ProviderSection
        key="nvidia-nim"
        id="nvidia-nim-accounts"
        providerKey="nvidia_nim"
        title="Nvidia"
        hideHeader={hasProviderFilter}
        accounts={nvidiaNimAccounts}
        emptyMessage="No Nvidia connections yet."
        supportedModels={supportedModelsByProvider?.nvidia_nim}
        disabledModelsByAccountId={disabledModelsByAccountId}
        isPinned={pinnedSet.has("nvidia_nim")}
        onTogglePin={handleTogglePin}
      />
    );
  }
  if (shouldRenderProvider("ollama_cloud")) {
    apiKeyProviderSections.push(
      <ProviderSection
        key="ollama-cloud"
        id="ollama-cloud-accounts"
        providerKey="ollama_cloud"
        title="Ollama Cloud"
        hideHeader={hasProviderFilter}
        accounts={ollamaCloudAccounts}
        emptyMessage="No Ollama Cloud connections yet."
        supportedModels={supportedModelsByProvider?.ollama_cloud}
        disabledModelsByAccountId={disabledModelsByAccountId}
        isPinned={pinnedSet.has("ollama_cloud")}
        onTogglePin={handleTogglePin}
      />
    );
  }
  if (shouldRenderProvider("openrouter")) {
    apiKeyProviderSections.push(
      <ProviderSection
        key="openrouter"
        id="openrouter-accounts"
        providerKey="openrouter"
        title="OpenRouter"
        hideHeader={hasProviderFilter}
        accounts={openRouterAccounts}
        emptyMessage="No OpenRouter connections yet."
        supportedModels={supportedModelsByProvider?.openrouter}
        quotaByAccountId={openRouterQuotaByAccountId}
        isQuotaLoading={isOpenRouterQuotaLoading}
        quotaLoadingAccountIds={quotaLoadingAccountIds.openRouter}
        onRefreshQuota={(accountId) => void fetchOpenRouterQuota(true, accountId)}
        disabledModelsByAccountId={disabledModelsByAccountId}
        isPinned={pinnedSet.has("openrouter")}
        onTogglePin={handleTogglePin}
      />
    );
  }
  if (shouldRenderProvider("groq")) {
    apiKeyProviderSections.push(
      <ProviderSection
        key="groq"
        id="groq-accounts"
        providerKey="groq"
        title="Groq Accounts"
        hideHeader={hasProviderFilter}
        accounts={groqAccounts}
        emptyMessage="No Groq accounts connected yet."
        supportedModels={supportedModelsByProvider?.groq}
        isPinned={pinnedSet.has("groq")}
        onTogglePin={handleTogglePin}
      />
    );
  }
  if (shouldRenderProvider("cerebras")) {
    apiKeyProviderSections.push(
      <ProviderSection
        key="cerebras"
        id="cerebras-accounts"
        providerKey="cerebras"
        title="Cerebras"
        hideHeader={hasProviderFilter}
        accounts={cerebrasAccounts}
        emptyMessage="No Cerebras accounts connected yet."
        supportedModels={supportedModelsByProvider?.cerebras}
        disabledModelsByAccountId={disabledModelsByAccountId}
        isPinned={pinnedSet.has("cerebras")}
        onTogglePin={handleTogglePin}
      />
    );
  }
  if (shouldRenderProvider("kilo_code")) {
    apiKeyProviderSections.push(
      <ProviderSection
        key="kilo-code"
        id="kilo-code-accounts"
        providerKey="kilo_code"
        title="Kilo Code"
        hideHeader={hasProviderFilter}
        accounts={kiloCodeAccounts}
        emptyMessage="No Kilo Code accounts connected yet."
        supportedModels={supportedModelsByProvider?.kilo_code}
        disabledModelsByAccountId={disabledModelsByAccountId}
        isPinned={pinnedSet.has("kilo_code")}
        onTogglePin={handleTogglePin}
      />
    );
  }
  if (shouldRenderProvider("workers_ai")) {
    apiKeyProviderSections.push(
      <ProviderSection
        key="workers-ai"
        id="workers-ai-accounts"
        providerKey="workers_ai"
        title="Workers AI"
        hideHeader={hasProviderFilter}
        accounts={workersAiAccounts}
        emptyMessage="No Workers AI accounts connected yet."
        supportedModels={supportedModelsByProvider?.workers_ai}
        disabledModelsByAccountId={disabledModelsByAccountId}
        isPinned={pinnedSet.has("workers_ai")}
        onTogglePin={handleTogglePin}
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
          <h3 className="text-base font-semibold">OAuth Providers</h3>
        </div>

        <div className="space-y-6">{oauthProviderSections}</div>
      </section>

      <section id="api-key-provider-accounts" className="space-y-5 md:space-y-3">
        <div className="space-y-1">
          <h3 className="text-base font-semibold">API Key Providers</h3>
        </div>

        <div className="space-y-6">{apiKeyProviderSections}</div>
      </section>
    </div>
  );
}
