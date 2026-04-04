import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { MobileNav } from "@/components/layout/sidebar";
import type {
  ModelFamilyCounts,
  ProviderAccountCounts,
  ProviderAccountIndicators,
} from "@/lib/navigation";
import type { ProviderAccountKey } from "@/lib/provider-accounts";
import { MODEL_REGISTRY, getProvidersForModel, resolveModelAlias } from "@opendum/shared/proxy/models";
import { type ModelStats, buildEmptyModelStats } from "@/lib/model-stats";
import { ModelSearchPopover } from "@/components/layout/model-search-popover";

const PROVIDER_LABELS: Record<string, string> = {
  antigravity: "Antigravity",
  qwen_code: "Qwen Code",
  gemini_cli: "Gemini CLI",
  codex: "Codex",
  copilot: "Copilot",
  kiro: "Kiro",
  nvidia_nim: "Nvidia",
  ollama_cloud: "Ollama Cloud",
  openrouter: "OpenRouter",
};

interface HeaderProps {
  accountCounts: ProviderAccountCounts;
  activeAccountCounts: ProviderAccountCounts;
  accountIndicators: ProviderAccountIndicators;
  modelFamilyCounts: ModelFamilyCounts;
  pinnedProviders: ProviderAccountKey[];
  disabledModels: Array<{ model: string }>;
  statsByModel: Record<string, ModelStats>;
  fallbackDayKeys: string[];
  fallbackHourKeys: string[];
  availableModelIds: string[];
  activeProviderNames: string[];
  user: {
    name: string | null;
    email: string | null;
    image: string | null;
  };
}

export function Header({
  accountCounts,
  activeAccountCounts,
  accountIndicators,
  modelFamilyCounts,
  pinnedProviders,
  disabledModels,
  statsByModel,
  fallbackDayKeys,
  fallbackHourKeys,
  availableModelIds,
  activeProviderNames,
  user,
}: HeaderProps) {
  const disabledModelSet = new Set(
    disabledModels.map((entry) => resolveModelAlias(entry.model))
  );

  const activeProviderSet = new Set(activeProviderNames);

  const models = availableModelIds
    .map((id: string) => ({
      id,
      providers: getProvidersForModel(id)
        .filter((p: string) => activeProviderSet.has(p))
        .map((provider: string) => PROVIDER_LABELS[provider] ?? provider),
      meta: MODEL_REGISTRY[id]?.meta,
      isEnabled: !disabledModelSet.has(id),
      stats: statsByModel[id] ?? buildEmptyModelStats(fallbackDayKeys, fallbackHourKeys),
    }))
    .sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id));

  return (
    <header className="sticky top-0 z-30 h-16 border-b border-border bg-background px-5 sm:px-6 lg:px-8">
      <div className="flex h-full w-full items-center gap-3 md:gap-0">
        <div className="flex min-w-0 items-center">
          <MobileNav
            accountCounts={accountCounts}
            activeAccountCounts={activeAccountCounts}
            accountIndicators={accountIndicators}
            modelFamilyCounts={modelFamilyCounts}
            pinnedProviders={pinnedProviders}
          />
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
                className="flex items-center justify-center rounded-full transition-opacity cursor-pointer hover:opacity-80"
              >
                <Avatar className="h-8 w-8">
                  <AvatarImage src={user.image ?? undefined} />
                  <AvatarFallback>
                    {user.name?.[0]?.toUpperCase() ?? "U"}
                  </AvatarFallback>
                </Avatar>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64 max-w-[calc(100vw-2rem)]">
              <DropdownMenuLabel>
                <div className="flex flex-col">
                  <span className="truncate">{user.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {user.email}
                  </span>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <form
                action={async () => {
                  "use server";
                  await auth.api.signOut({ headers: await headers() });
                  redirect("/");
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
