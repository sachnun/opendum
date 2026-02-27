"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, ChevronUp, X } from "lucide-react";
import {
  type ProviderAccountIndicator,
  type ProviderAccountIndicators,
  type ModelFamilyCounts,
  type NavItem,
  type ProviderAccountCounts,
  primaryNavigation,
  supportNavigation,
} from "@/lib/navigation";
import { getProviderAccountPath } from "@/lib/provider-accounts";
import { useSubNavigation } from "@/components/layout/use-sub-navigation";
import { Input } from "@/components/ui/input";

interface SidebarProps {
  accountCounts: ProviderAccountCounts;
  activeAccountCounts: ProviderAccountCounts;
  accountIndicators: ProviderAccountIndicators;
  modelFamilyCounts: ModelFamilyCounts;
}

function getAccountIndicatorClass(indicator: ProviderAccountIndicator): string {
  if (indicator === "error") {
    return "bg-red-500";
  }

  if (indicator === "warning") {
    return "bg-yellow-500";
  }

  return "bg-primary";
}

export function Sidebar({
  accountCounts,
  activeAccountCounts,
  accountIndicators,
  modelFamilyCounts,
}: SidebarProps) {
  const pathname = usePathname();
  const [accountsSubmenuSearch, setAccountsSubmenuSearch] = useState("");
  const { handleSubItemClick, isSubItemActive } = useSubNavigation(pathname, primaryNavigation);
  const normalizedAccountsSubmenuSearch = accountsSubmenuSearch.trim().toLowerCase();

  const isModelsActive =
    pathname === "/dashboard/models" || pathname.startsWith("/dashboard/models/");
  const [isModelsExpanded, setIsModelsExpanded] = useState(isModelsActive);

  useEffect(() => {
    if (isModelsActive) {
      setIsModelsExpanded(true);
    }
  }, [isModelsActive]);

  const primaryNavRef = useRef<HTMLElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [isBottomMenuExpanded, setIsBottomMenuExpanded] = useState(true);
  const userToggledRef = useRef(false);

  const checkOverflow = useCallback(() => {
    const el = primaryNavRef.current;
    if (!el) return;
    const overflowing = el.scrollHeight > el.clientHeight;
    setIsOverflowing(overflowing);
    if (!userToggledRef.current) {
      setIsBottomMenuExpanded(!overflowing);
    }
  }, []);

  useEffect(() => {
    const el = primaryNavRef.current;
    if (!el) return;

    checkOverflow();

    const resizeObserver = new ResizeObserver(() => {
      checkOverflow();
    });
    resizeObserver.observe(el);

    // Also observe children changes via MutationObserver
    const mutationObserver = new MutationObserver(() => {
      checkOverflow();
    });
    mutationObserver.observe(el, { childList: true, subtree: true });

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [checkOverflow]);

  const renderNavItem = (item: NavItem) => {
    const isActive =
      pathname === item.href ||
      (item.href !== "/dashboard" && pathname.startsWith(item.href));
    const isAccountsItem = item.href === "/dashboard/accounts";
    const isModelsItem = item.href === "/dashboard/models";
    const accountCountByHref: Record<string, number> = {
      [getProviderAccountPath("antigravity")]: accountCounts.antigravity,
      [getProviderAccountPath("nvidia_nim")]: accountCounts.nvidia_nim,
      [getProviderAccountPath("ollama_cloud")]: accountCounts.ollama_cloud,
      [getProviderAccountPath("openrouter")]: accountCounts.openrouter,
      [getProviderAccountPath("codex")]: accountCounts.codex,
      [getProviderAccountPath("copilot")]: accountCounts.copilot,
      [getProviderAccountPath("kiro")]: accountCounts.kiro,
      [getProviderAccountPath("iflow")]: accountCounts.iflow,
      [getProviderAccountPath("gemini_cli")]: accountCounts.gemini_cli,
      [getProviderAccountPath("qwen_code")]: accountCounts.qwen_code,
    };
    const activeAccountCountByHref: Record<string, number> = {
      [getProviderAccountPath("antigravity")]: activeAccountCounts.antigravity,
      [getProviderAccountPath("nvidia_nim")]: activeAccountCounts.nvidia_nim,
      [getProviderAccountPath("ollama_cloud")]: activeAccountCounts.ollama_cloud,
      [getProviderAccountPath("openrouter")]: activeAccountCounts.openrouter,
      [getProviderAccountPath("codex")]: activeAccountCounts.codex,
      [getProviderAccountPath("copilot")]: activeAccountCounts.copilot,
      [getProviderAccountPath("kiro")]: activeAccountCounts.kiro,
      [getProviderAccountPath("iflow")]: activeAccountCounts.iflow,
      [getProviderAccountPath("gemini_cli")]: activeAccountCounts.gemini_cli,
      [getProviderAccountPath("qwen_code")]: activeAccountCounts.qwen_code,
    };
    const accountIndicatorByHref: Record<string, ProviderAccountIndicator> = {
      [getProviderAccountPath("antigravity")]: accountIndicators.antigravity,
      [getProviderAccountPath("nvidia_nim")]: accountIndicators.nvidia_nim,
      [getProviderAccountPath("ollama_cloud")]: accountIndicators.ollama_cloud,
      [getProviderAccountPath("openrouter")]: accountIndicators.openrouter,
      [getProviderAccountPath("codex")]: accountIndicators.codex,
      [getProviderAccountPath("copilot")]: accountIndicators.copilot,
      [getProviderAccountPath("kiro")]: accountIndicators.kiro,
      [getProviderAccountPath("iflow")]: accountIndicators.iflow,
      [getProviderAccountPath("gemini_cli")]: accountIndicators.gemini_cli,
      [getProviderAccountPath("qwen_code")]: accountIndicators.qwen_code,
    };
    const modelCountByAnchorId = isModelsItem ? modelFamilyCounts : null;
    const visibleSubItems =
      isAccountsItem && item.children
        ? item.children.filter((subItem) =>
            subItem.name.toLowerCase().includes(normalizedAccountsSubmenuSearch)
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
              className="flex items-center px-3 py-2.5 text-muted-foreground transition-colors hover:text-foreground"
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
            {isAccountsItem ? (
              <div className="px-1 pb-1 pt-2">
                <div className="relative">
                  <Input
                    value={accountsSubmenuSearch}
                    onChange={(event) => setAccountsSubmenuSearch(event.target.value)}
                    placeholder="Search providers..."
                    aria-label="Search provider accounts"
                    className="h-7 border-0 bg-transparent px-2 pr-6 text-xs shadow-none focus-visible:border-transparent focus-visible:ring-0"
                  />
                  {accountsSubmenuSearch ? (
                    <button
                      type="button"
                      onClick={() => setAccountsSubmenuSearch("")}
                      className="absolute right-1 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                      aria-label="Clear search"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

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
                  const hasActiveAccounts =
                    typeof activeSubItemCount === "number" && activeSubItemCount > 0;
                  const shouldShowIndicator = isAccountsItem;

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
                      {shouldShowIndicator || shouldShowSubItemCount ? (
                        <span className="flex items-center gap-2">
                          {shouldShowIndicator ? (
                            hasActiveAccounts && subItemIndicator ? (
                              <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
                                <span
                                  className={cn(
                                    "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
                                    getAccountIndicatorClass(subItemIndicator)
                                  )}
                                />
                                <span
                                  className={cn(
                                    "relative inline-flex h-2.5 w-2.5 rounded-full",
                                    getAccountIndicatorClass(subItemIndicator)
                                  )}
                                />
                              </span>
                            ) : (
                              <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
                                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />
                              </span>
                            )
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
                <p className="px-2.5 py-1 text-[11px] text-muted-foreground">No providers found.</p>
              ) : null}
            </div>
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
      <div className="flex min-h-0 flex-1 flex-col px-3 py-4">
        <nav ref={primaryNavRef} className="min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="space-y-1">{primaryNavigation.map(renderNavItem)}</div>
        </nav>
        <div className="shrink-0">
          {isOverflowing ? (
            <button
              type="button"
              onClick={() => {
                userToggledRef.current = true;
                setIsBottomMenuExpanded((prev) => !prev);
              }}
              className="flex w-full items-center justify-center border-t border-border/60 pt-2 text-muted-foreground transition-colors hover:text-foreground"
              aria-label={isBottomMenuExpanded ? "Collapse menu" : "Expand menu"}
            >
              {isBottomMenuExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronUp className="h-4 w-4" />
              )}
            </button>
          ) : null}
          {isBottomMenuExpanded ? (
            <nav className={cn("space-y-1", isOverflowing ? "pt-2" : "mt-4 border-t border-border/60 pt-4")}>
              {supportNavigation.map(renderNavItem)}
            </nav>
          ) : null}
        </div>
      </div>
    </div>
  );
}
