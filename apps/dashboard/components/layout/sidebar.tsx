"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  type ProviderAccountIndicators,
  type ModelFamilyCounts,
  type NavItem,
  type ProviderAccountCounts,
  primaryNavigation,
  supportNavigation,
} from "@/lib/navigation";
import { buildProviderHrefMap, getProviderAccountPath } from "@/lib/provider-accounts";
import type { ProviderAccountKey } from "@/lib/provider-accounts";
import { useSubNavigation } from "@/components/layout/use-sub-navigation";
import { AccountStatusIndicator } from "@/components/layout/account-status-indicator";
import { useModelFamilyCounts } from "@/lib/model-family-counts-context";

interface SidebarNavContentProps {
  accountCounts: ProviderAccountCounts;
  activeAccountCounts: ProviderAccountCounts;
  accountIndicators: ProviderAccountIndicators;
  pinnedProviders: ProviderAccountKey[];
  onNavigate?: () => void;
}

function SidebarNavContent({
  accountCounts,
  activeAccountCounts,
  accountIndicators,
  pinnedProviders,
  onNavigate,
}: SidebarNavContentProps) {
  const pathname = usePathname();
  const { handleSubItemClick, isSubItemActive } = useSubNavigation(pathname, primaryNavigation);
  const { counts: liveModelFamilyCounts } = useModelFamilyCounts();

  const pinnedHrefs = new Set(
    pinnedProviders.map((key) => getProviderAccountPath(key))
  );

  const isModelsActive =
    pathname === "/dashboard/models" || pathname.startsWith("/dashboard/models/");
  const [isModelsExpanded, setIsModelsExpanded] = useState(isModelsActive);

  useEffect(() => {
    if (isModelsActive) {
      setIsModelsExpanded(true);
    }
  }, [isModelsActive]);

  const renderNavItem = (item: NavItem) => {
    const isActive =
      pathname === item.href ||
      (item.href !== "/dashboard" && pathname.startsWith(item.href));
    const isAccountsItem = item.href === "/dashboard/accounts";
    const isModelsItem = item.href === "/dashboard/models";
    const accountCountByHref = buildProviderHrefMap(accountCounts);
    const activeAccountCountByHref = buildProviderHrefMap(activeAccountCounts);
    const accountIndicatorByHref = buildProviderHrefMap(accountIndicators);
    const modelCountByAnchorId = isModelsItem ? liveModelFamilyCounts : null;
    const visibleSubItems =
      isAccountsItem && item.children
        ? item.children.filter((subItem) => pinnedHrefs.has(subItem.href))
        : isModelsItem && item.children && modelCountByAnchorId
          ? item.children.filter((subItem) =>
              subItem.anchorId ? (modelCountByAnchorId[subItem.anchorId] ?? 0) > 0 : true
            )
          : (item.children ?? []);

    const isCollapsible = isModelsItem;
    const isExpanded = isModelsItem ? isModelsExpanded : true;

    return (
      <div key={item.name} className="space-y-1">
        {isCollapsible ? (
          <div
            className={cn(
              "group flex items-center rounded-lg text-sm font-medium transition-all",
              isActive
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            <Link
              href={item.href}
              onClick={onNavigate}
              className="flex flex-1 items-center gap-3 py-2.5 pl-3"
            >
              <item.icon
                className={cn(
                  "h-4 w-4",
                  isActive ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"
                )}
              />
              {item.name}
            </Link>
            <button
              type="button"
              onClick={() => setIsModelsExpanded((prev) => !prev)}
              className="flex items-center px-3 py-2.5 text-muted-foreground transition-colors cursor-pointer hover:text-foreground"
              aria-label={isExpanded ? "Collapse models" : "Expand models"}
            >
              {isExpanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        ) : (
          <Link
            href={item.href}
            onClick={onNavigate}
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
        )}

        {item.children?.length && isExpanded ? (
          <div className="ml-6 space-y-1 border-l border-border/60 pl-3">
            <div>
              {visibleSubItems.length ? (
                visibleSubItems.map((subItem) => {
                  const isSubActive = isSubItemActive(subItem);
                  const subItemCount =
                    isAccountsItem
                      ? accountCountByHref[subItem.href]
                      : modelCountByAnchorId && subItem.anchorId
                        ? modelCountByAnchorId[subItem.anchorId]
                        : undefined;
                  const activeSubItemCount =
                    isAccountsItem ? activeAccountCountByHref[subItem.href] : undefined;
                  const subItemIndicator =
                    isAccountsItem ? accountIndicatorByHref[subItem.href] : undefined;
                  const shouldShowSubItemCount =
                    !isAccountsItem && typeof subItemCount === "number" && subItemCount > 0;
                  const shouldShowIndicator = isAccountsItem;

                  return (
                    <Link
                      key={`${item.name}-${subItem.name}`}
                      href={subItem.href}
                      prefetch={false}
                      onClick={(event) => {
                        handleSubItemClick(event, subItem);
                        onNavigate?.();
                      }}
                      className={cn(
                        "flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                        isSubActive
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground"
                      )}
                    >
                      <span className="truncate">{subItem.name}</span>
                      {shouldShowIndicator || shouldShowSubItemCount ? (
                        <span className="flex items-center gap-2">
                          {shouldShowIndicator ? (
                            <AccountStatusIndicator
                              activeAccountCount={activeSubItemCount}
                              indicator={subItemIndicator}
                            />
                          ) : null}
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
                        </span>
                      ) : null}
                    </Link>
                  );
                })
              ) : isAccountsItem ? (
                <p className="px-2.5 py-1 text-[11px] text-muted-foreground">No pinned providers.</p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col px-3 py-4">
      <nav className="min-h-0 flex-1 overflow-y-auto pr-1">
        <div className="space-y-1">{primaryNavigation.map(renderNavItem)}</div>
      </nav>
      <div className="shrink-0">
        <nav className="mt-4 space-y-1 border-t border-border/60 pt-4">
          {supportNavigation.map(renderNavItem)}
        </nav>
      </div>
    </div>
  );
}

interface SidebarProps {
  accountCounts: ProviderAccountCounts;
  activeAccountCounts: ProviderAccountCounts;
  accountIndicators: ProviderAccountIndicators;
  modelFamilyCounts: ModelFamilyCounts;
  pinnedProviders: ProviderAccountKey[];
}

export function Sidebar({
  accountCounts,
  activeAccountCounts,
  accountIndicators,
  pinnedProviders,
}: SidebarProps) {
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
      <SidebarNavContent
        accountCounts={accountCounts}
        activeAccountCounts={activeAccountCounts}
        accountIndicators={accountIndicators}
        pinnedProviders={pinnedProviders}
      />
    </div>
  );
}

export function MobileNav({
  accountCounts,
  activeAccountCounts,
  accountIndicators,
  pinnedProviders,
}: SidebarProps) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
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
      <SheetContent side="left" hideClose className="flex w-[78vw] max-w-[18rem] flex-col gap-0 p-0">
        <SheetHeader className="h-16 justify-center border-b border-border px-5">
          <SheetTitle className="text-left">
            <div className="flex items-center justify-between">
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
              <SheetClose className="opacity-70 transition-opacity cursor-pointer hover:opacity-100 focus:outline-none">
                <X className="h-4 w-4" />
                <span className="sr-only">Close</span>
              </SheetClose>
            </div>
          </SheetTitle>
        </SheetHeader>
        <SidebarNavContent
          accountCounts={accountCounts}
          activeAccountCounts={activeAccountCounts}
          accountIndicators={accountIndicators}
          pinnedProviders={pinnedProviders}
          onNavigate={() => setOpen(false)}
        />
      </SheetContent>
    </Sheet>
  );
}
