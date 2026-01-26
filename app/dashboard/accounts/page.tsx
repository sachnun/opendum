import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CheckCircle, XCircle, AlertCircle } from "lucide-react";
import { AccountActions } from "./account-actions";
import { AddAccountForm } from "./add-account-form";

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

  const accounts = await prisma.iflowAccount.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="space-y-4 md:space-y-6">
      <div>
        <h2 className="text-xl md:text-2xl font-bold tracking-tight">iFlow Accounts</h2>
        <p className="text-sm md:text-base text-muted-foreground">
          Manage your connected iFlow accounts for load balancing
        </p>
      </div>

      {params.success && (
        <Alert>
          <CheckCircle className="h-4 w-4" />
          <AlertDescription>
            iFlow account connected successfully!
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

      {/* Add Account Form */}
      <AddAccountForm />

      {/* Connected Accounts */}
      {accounts.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-base md:text-lg font-semibold">Connected Accounts</h3>
          <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {accounts.map((account) => (
              <Card key={account.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg">{account.name}</CardTitle>
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
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
