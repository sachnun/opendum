"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useState } from "react";
import {
  type NavItem,
  type ProviderAccountCounts,
  primaryNavigation,
  supportNavigation,
} from "@/lib/navigation";
import { useSubNavigation } from "@/components/layout/use-sub-navigation";

interface MobileNavProps {
  accountCounts: ProviderAccountCounts;
}

export function MobileNav({ accountCounts }: MobileNavProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [accountsSubmenuSearch, setAccountsSubmenuSearch] = useState("");
  const { handleSubItemClick, isSubItemActive } = useSubNavigation(pathname, primaryNavigation);
  const normalizedAccountsSubmenuSearch = accountsSubmenuSearch.trim().toLowerCase();

  const renderNavItem = (item: NavItem) => {
    const isActive =
      pathname === item.href ||
      (item.href !== "/dashboard" && pathname.startsWith(item.href));
    const isAccountsItem = item.href === "/dashboard/accounts";
    const accountCountByAnchorId: Record<string, number> = {
      "antigravity-accounts": accountCounts.antigravity,
      "nvidia-nim-accounts": accountCounts.nvidia_nim,
      "ollama-cloud-accounts": accountCounts.ollama_cloud,
      "codex-accounts": accountCounts.codex,
      "iflow-accounts": accountCounts.iflow,
      "gemini-cli-accounts": accountCounts.gemini_cli,
      "qwen-code-accounts": accountCounts.qwen_code,
    };
    const visibleSubItems =
      isAccountsItem && item.children
        ? item.children.filter((subItem) =>
            subItem.name.toLowerCase().includes(normalizedAccountsSubmenuSearch)
          )
        : (item.children ?? []);

    return (
      <div key={item.name} className="space-y-1">
        <Link
          href={item.href}
          onClick={() => setOpen(false)}
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
            {isAccountsItem ? (
              <div className="px-1 pb-1 pt-2">
                <Input
                  value={accountsSubmenuSearch}
                  onChange={(event) => setAccountsSubmenuSearch(event.target.value)}
                  placeholder="Search providers..."
                  aria-label="Search provider accounts"
                  className="h-7 border-0 bg-transparent px-2 text-xs shadow-none focus-visible:border-transparent focus-visible:ring-0"
                />
              </div>
            ) : null}

            <div className={cn(isAccountsItem && "max-h-48 overflow-y-auto pr-1")}>
              {visibleSubItems.length ? (
                visibleSubItems.map((subItem) => {
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
                      onClick={(event) => {
                        handleSubItemClick(event, subItem);
                        setOpen(false);
                      }}
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
                })
              ) : isAccountsItem ? (
                <p className="px-2.5 py-1 text-[11px] text-muted-foreground">No providers found.</p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setAccountsSubmenuSearch("");
        }
      }}
    >
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="rounded-lg border border-border bg-card md:hidden"
        >
          <Menu className="h-5 w-5" />
          <span className="sr-only">Toggle menu</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="flex w-[78vw] max-w-[18rem] flex-col gap-0 p-0">
        <SheetHeader className="border-b border-border px-5 py-4">
          <SheetTitle className="text-left">
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-2 text-base font-semibold tracking-tight"
              onClick={() => setOpen(false)}
            >
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
              </span>
              Opendum
            </Link>
          </SheetTitle>
        </SheetHeader>
        <nav className="flex flex-1 flex-col overflow-y-auto px-3 py-4">
          <div className="space-y-1">{primaryNavigation.map(renderNavItem)}</div>
          <div className="mt-auto space-y-1 border-t border-border/60 pt-4">
            {supportNavigation.map(renderNavItem)}
          </div>
        </nav>
      </SheetContent>
    </Sheet>
  );
}
