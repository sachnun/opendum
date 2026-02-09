"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import {
  AlertTriangle,
  AlertCircle,
  BarChart3,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getAntigravityQuota,
  type AccountQuotaInfo as AntigravityAccountQuotaInfo,
  type QuotaGroupDisplay as AntigravityQuotaGroupDisplay,
} from "@/lib/actions/antigravity-quota";
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
import { AccountActions } from "./account-actions";

type AccountQuotaInfo =
  | AntigravityAccountQuotaInfo
  | CodexAccountQuotaInfo
  | GeminiCliAccountQuotaInfo;
type QuotaGroupDisplay =
  | AntigravityQuotaGroupDisplay
  | CodexQuotaGroupDisplay
  | GeminiCliQuotaGroupDisplay;

// =============================================================================
// TYPES
// =============================================================================

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
  codexAccounts: Account[];
}

function formatUtcDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function buildSparklinePath(values: number[], width: number, height: number): string {
  if (values.length === 0) {
    return "";
  }

  const max = Math.max(...values);
  const min = Math.min(...values);
  const step = values.length > 1 ? width / (values.length - 1) : 0;

  if (max === min) {
    const y = max === 0 ? height : height / 2;
    return values
      .map((_, index) => `${index === 0 ? "M" : "L"}${(index * step).toFixed(2)},${y.toFixed(2)}`)
      .join(" ");
  }

  const range = max - min;

  return values
    .map((value, index) => {
      const x = index * step;
      const normalized = (value - min) / range;
      const y = height - normalized * height;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

function buildSparklineArea(path: string, width: number, height: number): string {
  if (!path) {
    return "";
  }

  return `${path} L${width},${height} L0,${height} Z`;
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

// =============================================================================
// STATUS BADGE COMPONENT
// =============================================================================

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
  const remainingLabel =
    group.models.length === 0
      ? `${percentRemaining}%`
      : `${group.remainingRequests}/${group.maxRequests}`;

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
        <span className="text-muted-foreground truncate">{group.displayName}</span>
        <span className={`font-mono ${textColor}`}>
          {remainingLabel}
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

// =============================================================================
// ACCOUNT CARD COMPONENT
// =============================================================================

function AccountCard({ 
  account, 
  showTier = false,
  quotaInfo,
  isQuotaLoading = false,
}: { 
  account: Account;
  showTier?: boolean;
  quotaInfo?: AccountQuotaInfo;
  isQuotaLoading?: boolean;
}) {
  const hasErrors = account.errorCount > 0;
  const supportsQuotaMonitor =
    account.provider === "antigravity" ||
    account.provider === "codex" ||
    account.provider === "gemini_cli";
  const chartWidth = 100;
  const chartHeight = 26;
  const dailyValues = account.stats.dailyRequests.map((point) => point.count);
  const hasUsage = dailyValues.some((value) => value > 0);
  const sparklinePath = buildSparklinePath(dailyValues, chartWidth, chartHeight);
  const areaPath = buildSparklineArea(sparklinePath, chartWidth, chartHeight);
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

  return (
    <Card className={`bg-card ${!account.isActive ? "opacity-65" : ""}`}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">{title}</CardTitle>
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
      <CardContent>
        <div className="space-y-2 text-sm">
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

            <svg
              viewBox={`0 0 ${chartWidth} ${chartHeight}`}
              className="h-8 w-full"
              role="img"
              aria-label={`Requests trend for ${title}`}
            >
              <path
                d={`M0,${chartHeight} L${chartWidth},${chartHeight}`}
                stroke="var(--border)"
                strokeWidth="1"
                fill="none"
              />
              {hasUsage && areaPath ? (
                <path d={areaPath} fill="var(--chart-2)" fillOpacity="0.18" stroke="none" />
              ) : null}
              {hasUsage && sparklinePath ? (
                <path
                  d={sparklinePath}
                  stroke="var(--chart-2)"
                  strokeWidth="2"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ) : (
                <text
                  x={chartWidth / 2}
                  y={chartHeight / 2 + 3}
                  textAnchor="middle"
                  className="fill-muted-foreground"
                  style={{ fontSize: 7 }}
                >
                  No activity yet
                </text>
              )}
            </svg>
          </div>

          <div className="flex justify-between">
            <span className="text-muted-foreground">Last used</span>
            <span className="font-medium">
              {account.lastUsedAt
                ? formatUtcDate(new Date(account.lastUsedAt))
                : "Never"}
            </span>
          </div>
          {hasErrors && (
            <>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Total Errors</span>
                <span className="font-medium text-red-500">{account.errorCount}</span>
              </div>
              {account.lastErrorAt && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Last Error</span>
                  <span className="font-medium text-red-500">
                    {formatUtcDate(new Date(account.lastErrorAt))}
                  </span>
                </div>
              )}
              {account.lastErrorMessage && (
                <div className="pt-2 border-t">
                  <span className="text-muted-foreground text-xs">Last Error Message:</span>
                  <p 
                    className="text-xs text-red-500 mt-1 line-clamp-2 break-all"
                    title={account.lastErrorMessage}
                  >
                    {account.lastErrorCode && `[${account.lastErrorCode}] `}
                    {account.lastErrorMessage.slice(0, 150)}
                    {account.lastErrorMessage.length > 150 && "..."}
                  </p>
                </div>
              )}
            </>
          )}

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

              {!account.isActive ? (
                <p className="text-xs text-muted-foreground">Activate account to view quota.</p>
              ) : isQuotaLoading && !quotaInfo ? (
                <div className="space-y-2">
                  <div className="h-1.5 w-full rounded-full bg-muted animate-pulse" />
                  <div className="h-1.5 w-full rounded-full bg-muted animate-pulse" />
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
        </div>
        <div className="mt-4 flex gap-2">
          <AccountActions account={account} />
        </div>
      </CardContent>
    </Card>
  );
}

// =============================================================================
// PROVIDER SECTION COMPONENT
// =============================================================================

interface ProviderSectionProps {
  id?: string;
  title: string;
  accounts: Account[];
  showTier?: boolean;
  emptyMessage: string;
  quotaByAccountId?: Record<string, AccountQuotaInfo>;
  isQuotaLoading?: boolean;
}

function ProviderSection({
  id,
  title,
  accounts,
  showTier = false,
  emptyMessage,
  quotaByAccountId,
  isQuotaLoading = false,
}: ProviderSectionProps) {
  return (
    <section id={id} className="scroll-mt-24 space-y-4">
      <div className="flex items-center gap-2">
        <h3 className="text-base md:text-lg font-semibold">{title}</h3>
        <Badge variant="outline" className="text-xs">
          {accounts.length} connected
        </Badge>
      </div>

      <div className="pl-3 pt-1 sm:pl-8">
        {accounts.length > 0 ? (
          <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {accounts.map((account) => (
              <AccountCard
                key={account.id}
                account={account}
                showTier={showTier}
                quotaInfo={quotaByAccountId?.[account.id]}
                isQuotaLoading={isQuotaLoading}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{emptyMessage}</p>
        )}
      </div>
    </section>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function AccountsList({
  antigravityAccounts,
  iflowAccounts,
  geminiCliAccounts,
  qwenCodeAccounts,
  codexAccounts,
}: AccountsListProps) {
  const [antigravityQuotaByAccountId, setAntigravityQuotaByAccountId] =
    useState<Record<string, AccountQuotaInfo>>({});
  const [codexQuotaByAccountId, setCodexQuotaByAccountId] =
    useState<Record<string, AccountQuotaInfo>>({});
  const [geminiCliQuotaByAccountId, setGeminiCliQuotaByAccountId] =
    useState<Record<string, AccountQuotaInfo>>({});
  const [isAntigravityQuotaLoading, startAntigravityQuotaTransition] = useTransition();
  const [isCodexQuotaLoading, startCodexQuotaTransition] = useTransition();
  const [isGeminiCliQuotaLoading, startGeminiCliQuotaTransition] = useTransition();

  const fetchAntigravityQuota = useCallback(() => {
    if (antigravityAccounts.length === 0) {
      return;
    }

    startAntigravityQuotaTransition(async () => {
      const result = await getAntigravityQuota();
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
    });
  }, [antigravityAccounts.length]);

  const fetchCodexQuota = useCallback(() => {
    if (codexAccounts.length === 0) {
      return;
    }

    startCodexQuotaTransition(async () => {
      const result = await getCodexQuota();
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
    });
  }, [codexAccounts.length]);

  const fetchGeminiCliQuota = useCallback(() => {
    if (geminiCliAccounts.length === 0) {
      return;
    }

    startGeminiCliQuotaTransition(async () => {
      const result = await getGeminiCliQuota();
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
    });
  }, [geminiCliAccounts.length]);

  useEffect(() => {
    if (antigravityAccounts.length === 0) {
      return;
    }

    const timeout = setTimeout(fetchAntigravityQuota, 0);
    const interval = setInterval(fetchAntigravityQuota, 5 * 60 * 1000);

    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [antigravityAccounts.length, fetchAntigravityQuota]);

  useEffect(() => {
    if (codexAccounts.length === 0) {
      return;
    }

    const timeout = setTimeout(fetchCodexQuota, 0);
    const interval = setInterval(fetchCodexQuota, 5 * 60 * 1000);

    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [codexAccounts.length, fetchCodexQuota]);

  useEffect(() => {
    if (geminiCliAccounts.length === 0) {
      return;
    }

    const timeout = setTimeout(fetchGeminiCliQuota, 0);
    const interval = setInterval(fetchGeminiCliQuota, 5 * 60 * 1000);

    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [geminiCliAccounts.length, fetchGeminiCliQuota]);

  return (
    <div className="space-y-6">
      {/* Antigravity Section */}
      <ProviderSection
        id="antigravity-accounts"
        title="Antigravity Accounts"
        accounts={antigravityAccounts}
        showTier
        emptyMessage="No Antigravity accounts connected yet."
        quotaByAccountId={antigravityQuotaByAccountId}
        isQuotaLoading={isAntigravityQuotaLoading}
      />

      {/* Codex Section */}
      <ProviderSection
        id="codex-accounts"
        title="Codex Accounts"
        accounts={codexAccounts}
        showTier
        emptyMessage="No Codex accounts connected yet."
        quotaByAccountId={codexQuotaByAccountId}
        isQuotaLoading={isCodexQuotaLoading}
      />

      {/* Iflow Section */}
      <ProviderSection
        id="iflow-accounts"
        title="Iflow Accounts"
        accounts={iflowAccounts}
        emptyMessage="No Iflow accounts connected yet."
      />

      {/* Gemini CLI Section */}
      <ProviderSection
        id="gemini-cli-accounts"
        title="Gemini CLI Accounts"
        accounts={geminiCliAccounts}
        showTier
        emptyMessage="No Gemini CLI accounts connected yet."
        quotaByAccountId={geminiCliQuotaByAccountId}
        isQuotaLoading={isGeminiCliQuotaLoading}
      />

      {/* Qwen Code Section */}
      <ProviderSection
        id="qwen-code-accounts"
        title="Qwen Code Accounts"
        accounts={qwenCodeAccounts}
        emptyMessage="No Qwen Code accounts connected yet."
      />
    </div>
  );
}
