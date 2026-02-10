import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { signOut } from "@/lib/auth";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { MobileNav } from "@/components/layout/mobile-nav";
import type { ProviderAccountCounts } from "@/lib/navigation";
import { MODEL_REGISTRY } from "@/lib/proxy/models";
import { ModelSearchPopover } from "@/components/layout/model-search-popover";

const PROVIDER_LABELS: Record<string, string> = {
  iflow: "Iflow",
  antigravity: "Antigravity",
  qwen_code: "Qwen Code",
  gemini_cli: "Gemini CLI",
  codex: "Codex",
  nvidia_nim: "Nvidia",
  ollama_cloud: "Ollama Cloud",
};

interface HeaderProps {
  accountCounts: ProviderAccountCounts;
}

export async function Header({ accountCounts }: HeaderProps) {
  const session = await auth();

  const disabledModels = session?.user?.id
    ? await prisma.disabledModel.findMany({
        where: { userId: session.user.id },
        select: { model: true },
      })
    : [];
  const disabledModelSet = new Set(
    disabledModels.map((entry: { model: string }) => entry.model)
  );

  const models = Object.entries(MODEL_REGISTRY)
    .filter(([id]) => !disabledModelSet.has(id))
    .map(([id, info]) => ({
      id,
      providers: info.providers.map((provider) => PROVIDER_LABELS[provider] ?? provider),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return (
    <header className="sticky top-0 z-30 h-16 border-b border-border bg-background px-5 sm:px-6 lg:px-8">
      <div className="mx-auto flex h-full w-full max-w-7xl items-center gap-3 md:gap-0">
        <div className="flex min-w-0 items-center">
          <MobileNav accountCounts={accountCounts} />
        </div>
        <div className="min-w-0 flex-1">
          <ModelSearchPopover models={models} className="mx-auto max-w-xl" />
        </div>
        <div className="flex items-center gap-1.5 sm:gap-2">
          <ThemeToggle />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center justify-center rounded-full transition-opacity hover:opacity-80"
              >
                <Avatar className="h-8 w-8">
                  <AvatarImage src={session?.user?.image ?? undefined} />
                  <AvatarFallback>
                    {session?.user?.name?.[0]?.toUpperCase() ?? "U"}
                  </AvatarFallback>
                </Avatar>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel>
                <div className="flex flex-col">
                  <span>{session?.user?.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {session?.user?.email}
                  </span>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <form
                action={async () => {
                  "use server";
                  await signOut({ redirectTo: "/" });
                }}
              >
                <DropdownMenuItem asChild>
                  <button className="w-full cursor-pointer text-left">Sign out</button>
                </DropdownMenuItem>
              </form>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
