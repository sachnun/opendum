import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CheckCircle, AlertCircle } from "lucide-react";
import { AddAccountDialog } from "./add-account-dialog";
import { AccountsList } from "./accounts-list";

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
  const qwenCodeAccounts = accounts.filter((a) => a.provider === "qwen_code");
  const geminiCliAccounts = accounts.filter((a) => a.provider === "gemini_cli");

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
              : params.success === "qwen_code_added"
                ? "Qwen Code account connected successfully!"
                : params.success === "gemini_cli_added"
                  ? "Gemini CLI account connected successfully!"
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

      {/* Client Component for Collapsible Sections */}
      <AccountsList
        antigravityAccounts={antigravityAccounts}
        iflowAccounts={iflowAccounts}
        geminiCliAccounts={geminiCliAccounts}
        qwenCodeAccounts={qwenCodeAccounts}
      />
    </div>
  );
}
