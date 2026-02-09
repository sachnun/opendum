"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  type NavItem,
  type ProviderAccountCounts,
  primaryNavigation,
  supportNavigation,
} from "@/lib/navigation";
import { useSubNavigation } from "@/components/layout/use-sub-navigation";

interface SidebarProps {
  accountCounts: ProviderAccountCounts;
}

export function Sidebar({ accountCounts }: SidebarProps) {
  const pathname = usePathname();
  const { handleSubItemClick, isSubItemActive } = useSubNavigation(pathname, primaryNavigation);

  const renderNavItem = (item: NavItem) => {
    const isActive =
      pathname === item.href ||
      (item.href !== "/dashboard" && pathname.startsWith(item.href));
    const isAccountsItem = item.href === "/dashboard/accounts";
    const accountCountByAnchorId: Record<string, number> = {
      "antigravity-accounts": accountCounts.antigravity,
      "codex-accounts": accountCounts.codex,
      "iflow-accounts": accountCounts.iflow,
      "gemini-cli-accounts": accountCounts.gemini_cli,
      "qwen-code-accounts": accountCounts.qwen_code,
    };

    return (
      <div key={item.name} className="space-y-1">
        <Link
          href={item.href}
          className={cn(
            "group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all",
            isActive
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground"
          )}
        >
          <item.icon
            className={cn(
              "h-4 w-4",
              isActive ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"
            )}
          />
          {item.name}
        </Link>

        {item.children?.length ? (
          <div className="ml-6 space-y-1 border-l border-border/60 pl-3">
            {item.children.map((subItem) => {
              const isSubActive = isSubItemActive(subItem);
              const subItemCount =
                isAccountsItem && subItem.anchorId
                  ? accountCountByAnchorId[subItem.anchorId]
                  : undefined;
              const shouldShowSubItemCount =
                typeof subItemCount === "number" && subItemCount > 0;

              return (
                <Link
                  key={`${item.name}-${subItem.name}`}
                  href={subItem.href}
                  onClick={(event) => handleSubItemClick(event, subItem)}
                  className={cn(
                    "flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                    isSubActive
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  )}
                >
                  <span className="truncate">{subItem.name}</span>
                  {shouldShowSubItemCount ? (
                    <span
                      className={cn(
                        "rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none",
                        isSubActive
                          ? "bg-background text-foreground"
                          : "bg-muted text-muted-foreground"
                      )}
                    >
                      {subItemCount}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="hidden md:sticky md:top-0 md:flex md:h-svh md:w-60 md:flex-col md:border-r md:border-border md:bg-card">
      <div className="flex h-16 items-center border-b border-border px-5">
        <Link href="/dashboard" className="inline-flex items-center gap-2.5">
          <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
            </span>
          <span className="text-base font-semibold tracking-tight">Opendum</span>
        </Link>
      </div>
      <nav className="flex flex-1 flex-col px-3 py-4">
        <div className="space-y-1">{primaryNavigation.map(renderNavItem)}</div>
        <div className="mt-auto space-y-1 border-t border-border/60 pt-4">
          {supportNavigation.map(renderNavItem)}
        </div>
      </nav>
    </div>
  );
}
