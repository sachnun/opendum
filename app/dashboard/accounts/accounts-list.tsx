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
}

interface AccountsListProps {
  antigravityAccounts: Account[];
  iflowAccounts: Account[];
  geminiCliAccounts: Account[];
  qwenCodeAccounts: Account[];
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
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">{account.name}</CardTitle>
          <div className="flex gap-1">
            {showTier && account.tier && (
              <Badge 
                variant="outline" 
                className={account.tier === "paid" ? "border-green-500 text-green-600" : ""}
              >
                {account.tier}
              </Badge>
            )}
            <Badge variant={account.isActive ? "default" : "secondary"}>
              {account.isActive ? (
                <>
                  <CheckCircle className="mr-1 h-3 w-3" />
                  Active
                </>
              ) : (
                <>
                  <XCircle className="mr-1 h-3 w-3" />
                  Inactive
                </>
              )}
            </Badge>
          </div>
        </div>
        <CardDescription>{account.email || "No email"}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2 text-sm">
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
          <div className="flex justify-between">
            <span className="text-muted-foreground">Token expires</span>
            <span className="font-medium">
              {new Date(account.expiresAt).toLocaleDateString()}
            </span>
          </div>
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
