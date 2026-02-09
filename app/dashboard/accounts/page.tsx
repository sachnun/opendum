import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CheckCircle, AlertCircle } from "lucide-react";
import { AddAccountDialog } from "@/components/dashboard/accounts/add-account-dialog";
import { AccountsList } from "@/components/dashboard/accounts/accounts-list";

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
  const codexAccounts = accounts.filter((a) => a.provider === "codex");

  return (
    <div className="space-y-6">
      <div className="relative">
        <div className="md:fixed md:inset-x-0 md:top-16 md:z-20 md:left-60 md:bg-background md:pt-2">
          <div className="mx-auto w-full max-w-7xl px-5 sm:px-6 lg:px-8">
            <div className="bg-background">
              <div className="pb-4 border-b border-border">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <h2 className="text-xl font-semibold">Provider Accounts</h2>
                  <AddAccountDialog />
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="hidden h-16 md:block" />
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
                  : params.success === "codex_added"
                    ? "Codex account connected successfully!"
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

      <AccountsList
        antigravityAccounts={antigravityAccounts}
        iflowAccounts={iflowAccounts}
        geminiCliAccounts={geminiCliAccounts}
        qwenCodeAccounts={qwenCodeAccounts}
        codexAccounts={codexAccounts}
      />
    </div>
  );
}
