"use client";

/**
 * Quota Monitor Component
 * 
 * Displays real-time quota information for Antigravity accounts.
 * Auto-refreshes every 5 minutes.
 */

import { useEffect, useState, useTransition, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { 
  RefreshCw, 
  AlertCircle, 
  CheckCircle2, 
  Clock, 
  Zap,
  AlertTriangle,
} from "lucide-react";
import { 
  getAntigravityQuota, 
  type AccountQuotaInfo, 
  type QuotaGroupDisplay,
  type QuotaSummary,
} from "@/lib/actions/antigravity-quota";

// =============================================================================
// TYPES
// =============================================================================

interface QuotaMonitorProps {
  autoRefresh?: boolean;
  refreshIntervalMs?: number;
  compact?: boolean;
}

// =============================================================================
// QUOTA BAR COMPONENT
// =============================================================================

function QuotaBar({ 
  group, 
  compact = false 
}: { 
  group: QuotaGroupDisplay; 
  compact?: boolean;
}) {
  const percentRemaining = Math.round(group.remainingFraction * 100);
  const percentUsed = 100 - percentRemaining;
  
  // Color based on remaining percentage
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

  if (compact) {
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium truncate">{group.displayName}</span>
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

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-medium">{group.displayName}</span>
          {group.isEstimated && (
            <Badge variant="outline" className="text-[10px] px-1 py-0">
              ~estimated
            </Badge>
          )}
          {group.confidence === "low" && group.isEstimated && (
            <AlertTriangle className="h-3 w-3 text-yellow-500" />
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-sm font-mono ${textColor}`}>
            {group.remainingRequests}/{group.maxRequests}
          </span>
          <span className="text-xs text-muted-foreground">
            ({percentRemaining}%)
          </span>
        </div>
      </div>
      
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div 
          className={`h-full ${barColor} transition-all duration-300`}
          style={{ width: `${percentRemaining}%` }}
        />
      </div>
      
      {group.resetInHuman && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Clock className="h-3 w-3" />
          <span>Resets in {group.resetInHuman}</span>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// ACCOUNT CARD COMPONENT
// =============================================================================

function AccountQuotaCard({ 
  account,
  compact = false,
}: { 
  account: AccountQuotaInfo;
  compact?: boolean;
}) {
  const tierBadge = account.tier === "standard-tier" || account.tier === "paid" 
    ? { label: "Paid", variant: "default" as const }
    : { label: "Free", variant: "secondary" as const };

  const statusIcon = account.status === "success" 
    ? <CheckCircle2 className="h-3 w-3 text-green-500" />
    : account.status === "expired"
    ? <AlertTriangle className="h-3 w-3 text-yellow-500" />
    : <AlertCircle className="h-3 w-3 text-red-500" />;

  if (compact) {
    return (
      <div className="p-3 border rounded-lg space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {statusIcon}
            <span className="text-sm font-medium truncate max-w-[150px]">
              {account.email ?? account.accountName}
            </span>
          </div>
          <Badge variant={tierBadge.variant} className="text-[10px]">
            {tierBadge.label}
          </Badge>
        </div>
        
        {account.status === "success" && account.groups.length > 0 && (
          <div className="space-y-1.5">
            {account.groups.map((group) => (
              <QuotaBar key={group.name} group={group} compact />
            ))}
          </div>
        )}
        
        {account.status !== "success" && (
          <p className="text-xs text-red-500">{account.error}</p>
        )}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {statusIcon}
            <CardTitle className="text-base">
              {account.email ?? account.accountName}
            </CardTitle>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={tierBadge.variant}>{tierBadge.label}</Badge>
            {!account.isActive && (
              <Badge variant="outline" className="text-yellow-600">Inactive</Badge>
            )}
          </div>
        </div>
      </CardHeader>
      
      <CardContent className="space-y-4">
        {account.status === "success" && account.groups.length > 0 ? (
          account.groups.map((group) => (
            <QuotaBar key={group.name} group={group} />
          ))
        ) : account.status === "expired" ? (
          <div className="flex items-center gap-2 text-yellow-600">
            <AlertTriangle className="h-4 w-4" />
            <span className="text-sm">{account.error}</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-red-500">
            <AlertCircle className="h-4 w-4" />
            <span className="text-sm">{account.error ?? "Failed to fetch quota"}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// =============================================================================
// LOADING SKELETON
// =============================================================================

function QuotaMonitorSkeleton({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <div className="space-y-3">
        {[1, 2].map((i) => (
          <div key={i} className="p-3 border rounded-lg space-y-2">
            <div className="flex items-center justify-between">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-12" />
            </div>
            <Skeleton className="h-1.5 w-full" />
            <Skeleton className="h-1.5 w-full" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {[1, 2].map((i) => (
        <Card key={i}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-5 w-16" />
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {[1, 2, 3].map((j) => (
              <div key={j} className="space-y-2">
                <div className="flex justify-between">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-4 w-16" />
                </div>
                <Skeleton className="h-2 w-full" />
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function QuotaMonitor({
  autoRefresh = true,
  refreshIntervalMs = 5 * 60 * 1000, // 5 minutes
  compact = false,
}: QuotaMonitorProps) {
  const [accounts, setAccounts] = useState<AccountQuotaInfo[]>([]);
  const [summary, setSummary] = useState<QuotaSummary | null>(null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);

  const fetchQuota = useCallback(() => {
    startTransition(async () => {
      const result = await getAntigravityQuota();
      if (result.success) {
        setAccounts(result.data.accounts);
        setSummary(result.data.summary);
        setError(null);
        setLastFetched(new Date());
      } else {
        setError(result.error);
      }
    });
  }, []);

  useEffect(() => {
    fetchQuota();

    if (autoRefresh) {
      const interval = setInterval(fetchQuota, refreshIntervalMs);
      return () => clearInterval(interval);
    }
  }, [fetchQuota, autoRefresh, refreshIntervalMs]);

  // No accounts state
  if (!isPending && accounts.length === 0 && !error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Zap className="h-4 w-4" />
            Antigravity Quota
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No Antigravity accounts connected. Add an account to monitor quota.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (compact) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Zap className="h-4 w-4" />
              Antigravity Quota
            </CardTitle>
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={fetchQuota} 
              disabled={isPending}
              className="h-7 w-7 p-0"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isPending ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isPending && accounts.length === 0 ? (
            <QuotaMonitorSkeleton compact />
          ) : error ? (
            <div className="flex items-center gap-2 text-red-500 text-sm">
              <AlertCircle className="h-4 w-4" />
              <span>{error}</span>
            </div>
          ) : (
            <div className="space-y-3">
              {accounts.map((account) => (
                <AccountQuotaCard 
                  key={account.accountId} 
                  account={account} 
                  compact 
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Zap className="h-5 w-5" />
            Antigravity Quota
          </h3>
          {lastFetched && (
            <p className="text-xs text-muted-foreground">
              Last updated: {lastFetched.toLocaleTimeString()}
            </p>
          )}
        </div>
        <Button 
          variant="outline" 
          size="sm" 
          onClick={fetchQuota} 
          disabled={isPending}
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${isPending ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Summary */}
      {summary && summary.totalAccounts > 0 && (
        <div className="flex flex-wrap gap-2 text-sm">
          <Badge variant="outline">
            {summary.activeAccounts}/{summary.totalAccounts} accounts active
          </Badge>
          {summary.exhaustedGroups > 0 && (
            <Badge variant="destructive">
              {summary.exhaustedGroups} quota exhausted
            </Badge>
          )}
          {Object.entries(summary.byTier).map(([tier, count]) => (
            <Badge 
              key={tier} 
              variant={tier === "standard-tier" || tier === "paid" ? "default" : "secondary"}
            >
              {count} {tier === "standard-tier" || tier === "paid" ? "paid" : "free"}
            </Badge>
          ))}
        </div>
      )}

      {/* Content */}
      {isPending && accounts.length === 0 ? (
        <QuotaMonitorSkeleton />
      ) : error ? (
        <Card>
          <CardContent className="flex items-center gap-2 text-red-500 py-4">
            <AlertCircle className="h-5 w-5" />
            <span>{error}</span>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {accounts.map((account) => (
            <AccountQuotaCard key={account.accountId} account={account} />
          ))}
        </div>
      )}
    </div>
  );
}
