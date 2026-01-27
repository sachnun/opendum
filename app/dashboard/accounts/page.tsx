import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CheckCircle, XCircle, AlertCircle, Sparkles, Zap } from "lucide-react";
import { AccountActions } from "./account-actions";
import { AddAccountDialog } from "./add-account-dialog";

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const session = await auth();
  const params = await searchParams;

  if (!session?.user?.id) {
    return null;
  }

  const accounts = await prisma.providerAccount.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
  });

  // Group accounts by provider
  const iflowAccounts = accounts.filter((a) => a.provider === "iflow");
  const antigravityAccounts = accounts.filter((a) => a.provider === "antigravity");

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl md:text-2xl font-bold tracking-tight">Provider Accounts</h2>
          <p className="text-sm md:text-base text-muted-foreground">
            Manage your connected AI provider accounts for load balancing
          </p>
        </div>
        <AddAccountDialog />
      </div>

      {params.success && (
        <Alert>
          <CheckCircle className="h-4 w-4" />
          <AlertDescription>
            {params.success === "antigravity_added"
              ? "Antigravity account connected successfully!"
              : "Account connected successfully!"}
          </AlertDescription>
        </Alert>
      )}

      {params.error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to connect account: {decodeURIComponent(params.error)}
          </AlertDescription>
        </Alert>
      )}

      {/* iFlow Section */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Zap className="h-5 w-5 text-blue-500" />
          <h3 className="text-base md:text-lg font-semibold">iFlow Accounts</h3>
          <Badge variant="outline" className="text-xs">
            {iflowAccounts.length} connected
          </Badge>
        </div>

        {/* iFlow Accounts List */}
        {iflowAccounts.length > 0 ? (
          <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {iflowAccounts.map((account) => (
              <AccountCard key={account.id} account={account} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No iFlow accounts connected yet.</p>
        )}
      </div>

      {/* Antigravity Section */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-purple-500" />
          <h3 className="text-base md:text-lg font-semibold">Antigravity Accounts</h3>
          <Badge variant="outline" className="text-xs">
            {antigravityAccounts.length} connected
          </Badge>
        </div>

        {/* Antigravity Accounts List */}
        {antigravityAccounts.length > 0 ? (
          <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {antigravityAccounts.map((account) => (
              <AccountCard key={account.id} account={account} showTier />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No Antigravity accounts connected yet.</p>
        )}
      </div>
    </div>
  );
}

function AccountCard({ 
  account, 
  showTier = false 
}: { 
  account: {
    id: string;
    name: string;
    provider: string;
    email: string | null;
    isActive: boolean;
    requestCount: number;
    lastUsedAt: Date | null;
    expiresAt: Date;
    tier: string | null;
  };
  showTier?: boolean;
}) {
  const providerColor = account.provider === "antigravity" ? "purple" : "blue";
  
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
            <span className="text-muted-foreground">Provider</span>
            <Badge 
              variant="outline" 
              className={`text-${providerColor}-600 border-${providerColor}-300`}
            >
              {account.provider === "antigravity" ? "Antigravity" : "iFlow"}
            </Badge>
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
