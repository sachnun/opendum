"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { 
  Collapsible, 
  CollapsibleContent, 
  CollapsibleTrigger 
} from "@/components/ui/collapsible";
import { 
  CheckCircle, 
  XCircle, 
  Sparkles, 
  Zap, 
  Terminal, 
  Cpu,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  AlertCircle,
} from "lucide-react";
import { AccountActions } from "./account-actions";
import { useState } from "react";

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

// =============================================================================
// ACCOUNT CARD COMPONENT
// =============================================================================

function AccountCard({ 
  account, 
  showTier = false 
}: { 
  account: Account;
  showTier?: boolean;
}) {
  const hasErrors = account.errorCount > 0;
  const successRate = account.successCount + account.errorCount > 0
    ? Math.round((account.successCount / (account.successCount + account.errorCount)) * 100)
    : 100;

  return (
    <Card className={account.status === "failed" ? "border-red-300 dark:border-red-800" : account.status === "degraded" ? "border-yellow-300 dark:border-yellow-800" : ""}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">{account.name}</CardTitle>
          <div className="flex gap-1 flex-wrap justify-end">
            {showTier && account.tier && (
              <Badge 
                variant="outline" 
                className={account.tier === "paid" ? "border-green-500 text-green-600" : ""}
              >
                {account.tier}
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
        <CardDescription>{account.email || "No email"}</CardDescription>
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
                ? new Date(account.lastUsedAt).toLocaleDateString()
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
                    {new Date(account.lastErrorAt).toLocaleDateString()}
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
  icon: React.ReactNode;
  title: string;
  accounts: Account[];
  showTier?: boolean;
  defaultOpen?: boolean;
  emptyMessage: string;
}

function ProviderSection({
  icon,
  title,
  accounts,
  showTier = false,
  defaultOpen = false,
  emptyMessage,
}: ProviderSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className="space-y-4">
        <CollapsibleTrigger asChild>
          <Button 
            variant="ghost" 
            className="w-full justify-start p-0 h-auto hover:bg-transparent"
          >
            <div className="flex items-center gap-2 w-full">
              <div className="flex items-center justify-center w-6 h-6">
                {isOpen ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
              </div>
              {icon}
              <h3 className="text-base md:text-lg font-semibold">{title}</h3>
              <Badge variant="outline" className="text-xs">
                {accounts.length} connected
              </Badge>
            </div>
          </Button>
        </CollapsibleTrigger>

        <CollapsibleContent className="pl-8">
          {accounts.length > 0 ? (
            <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              {accounts.map((account) => (
                <AccountCard key={account.id} account={account} showTier={showTier} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{emptyMessage}</p>
          )}
        </CollapsibleContent>
      </div>
    </Collapsible>
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
}: AccountsListProps) {
  return (
    <div className="space-y-6">
      {/* Antigravity Section - Default OPEN */}
      <ProviderSection
        icon={<Sparkles className="h-5 w-5" />}
        title="Antigravity Accounts"
        accounts={antigravityAccounts}
        showTier
        defaultOpen={true}
        emptyMessage="No Antigravity accounts connected yet."
      />

      {/* Iflow Section - Default CLOSED */}
      <ProviderSection
        icon={<Zap className="h-5 w-5" />}
        title="Iflow Accounts"
        accounts={iflowAccounts}
        defaultOpen={false}
        emptyMessage="No Iflow accounts connected yet."
      />

      {/* Gemini CLI Section - Default CLOSED */}
      <ProviderSection
        icon={<Cpu className="h-5 w-5" />}
        title="Gemini CLI Accounts"
        accounts={geminiCliAccounts}
        showTier
        defaultOpen={false}
        emptyMessage="No Gemini CLI accounts connected yet."
      />

      {/* Qwen Code Section - Default CLOSED */}
      <ProviderSection
        icon={<Terminal className="h-5 w-5" />}
        title="Qwen Code Accounts"
        accounts={qwenCodeAccounts}
        defaultOpen={false}
        emptyMessage="No Qwen Code accounts connected yet."
      />
    </div>
  );
}
