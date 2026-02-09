"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import {
  CheckCircle, 
  XCircle, 
  AlertTriangle,
  AlertCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getAntigravityQuota,
  type AccountQuotaInfo,
  type QuotaGroupDisplay,
} from "@/lib/actions/antigravity-quota";
import { AccountActions } from "./account-actions";

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
  return (
    <Badge variant="default" className="gap-1">
      <CheckCircle className="h-3 w-3" />
      Active
    </Badge>
  );
}

function QuotaGroupBar({ group }: { group: QuotaGroupDisplay }) {
  const percentRemaining = Math.max(0, Math.min(100, Math.round(group.remainingFraction * 100)));

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
          {group.remainingRequests}/{group.maxRequests}
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
  const isAntigravity = account.provider === "antigravity";
  const successRate = account.successCount + account.errorCount > 0
    ? Math.round((account.successCount / (account.successCount + account.errorCount)) * 100)
    : 100;
  const { title, subtitle } = getAccountHeader(account);
  const isPaidTier = account.tier === "paid" || account.tier === "standard-tier";
  const tierLabel =
    account.tier === "paid" || account.tier === "standard-tier"
      ? "Paid"
      : account.tier === "free"
        ? "Free"
        : account.tier;

  return (
    <Card className={`bg-card ${!account.isActive ? "opacity-65" : ""}`}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">{title}</CardTitle>
          <div className="flex gap-1 flex-wrap justify-end">
            {showTier && account.tier && (
              <Badge 
                variant="outline" 
                className={isPaidTier ? "border-green-500 text-green-600" : ""}
              >
                {tierLabel}
              </Badge>
            )}
            {account.isActive ? (
              <StatusBadge status={account.status} consecutiveErrors={account.consecutiveErrors} />
            ) : (
              <Badge variant="secondary">
                <XCircle className="mr-1 h-3 w-3" />
                Inactive
              </Badge>
            )}
          </div>
        </div>
        {subtitle && <CardDescription>{subtitle}</CardDescription>}
      </CardHeader>
      <CardContent>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Success Rate</span>
            <span className={`font-medium ${successRate < 80 ? "text-red-500" : successRate < 95 ? "text-yellow-500" : "text-green-500"}`}>
              {successRate}% ({account.successCount}/{account.successCount + account.errorCount})
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Requests</span>
            <span className="font-medium">{account.requestCount}</span>
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

          {isAntigravity && (
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
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2.5">
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
  const [quotaByAccountId, setQuotaByAccountId] = useState<Record<string, AccountQuotaInfo>>({});
  const [isQuotaLoading, startQuotaTransition] = useTransition();

  const fetchAntigravityQuota = useCallback(() => {
    if (antigravityAccounts.length === 0) {
      return;
    }

    startQuotaTransition(async () => {
      const result = await getAntigravityQuota();
      if (!result.success) {
        setQuotaByAccountId({});
        return;
      }

      const quotaMap = result.data.accounts.reduce<Record<string, AccountQuotaInfo>>(
        (accumulator, accountQuota) => {
          accumulator[accountQuota.accountId] = accountQuota;
          return accumulator;
        },
        {}
      );

      setQuotaByAccountId(quotaMap);
    });
  }, [antigravityAccounts.length]);

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

  return (
    <div className="space-y-6">
      {/* Antigravity Section */}
      <ProviderSection
        id="antigravity-accounts"
        title="Antigravity Accounts"
        accounts={antigravityAccounts}
        showTier
        emptyMessage="No Antigravity accounts connected yet."
        quotaByAccountId={quotaByAccountId}
        isQuotaLoading={isQuotaLoading}
      />

      {/* Codex Section */}
      <ProviderSection
        id="codex-accounts"
        title="Codex Accounts"
        accounts={codexAccounts}
        emptyMessage="No Codex accounts connected yet."
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
