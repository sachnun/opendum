import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { signOut, useSession } from "../lib/auth-client";
import { primaryNavigation, type NavItem, type NavSubItem, type ProviderAccountCounts, type ProviderAccountIndicators, type ModelFamilyCounts } from "../lib/navigation";
import { MODEL_FAMILY_NAV_ITEMS, categorizeModelFamily } from "../lib/model-families";
import { buildProviderHrefMap, getProviderAccountPath, PROVIDER_ACCOUNT_DEFINITIONS } from "../lib/provider-accounts";
import type { AccountOverviewData, AccountOverviewResponse, AccountPingData, PointStatusData } from "../lib/dashboard-api-types";
import { useDashboardApi } from "../hooks/useDashboardApi";
import { useDashboardDataInvalidation, useDataVersion } from "../hooks/useDashboardDataInvalidation";
import { useDashboardAudit } from "../hooks/useDashboardAudit";
import { ModelSearchPopover } from "../components/ModelSearchPopover";
import { AccountStatusIndicator } from "../components/AccountStatusIndicator";
import { PointCoinIcon } from "../components/PointCoinIcon";
import { MaintenerAuditDialog } from "../components/MaintenerAuditDialog";
import { UiBadge } from "../components/ui/UiBadge";
import { UiButton } from "../components/ui/UiButton";
import { UiDialog } from "../components/ui/UiDialog";
import { UiIcon } from "../components/ui/UiIcon";
import { UiPopover } from "../components/ui/UiPopover";
import { UiSheet } from "../components/ui/UiSheet";
import { UiSwitch } from "../components/ui/UiSwitch";
import { UiTooltip } from "../components/ui/UiTooltip";
import { cn } from "../lib/utils";

type ProviderAccountKey = (typeof PROVIDER_ACCOUNT_DEFINITIONS)[number]["key"];

const PROVIDER_AVAILABILITY_ORDER = { active: 0, inactive: 1 } as const;
const PROVIDER_STATUS_ORDER = { error: 0, warning: 1, normal: 2 } as const;
const ACCOUNT_SUMMARY_REFRESH_MS = 30_000;
const POINT_STATUS_REFRESH_MS = 15_000;

const supportNavigation: NavItem[] = [
  {
    name: "Tools",
    href: "/dashboard/tools",
    icon: "i-lucide-wrench",
    children: [
      { name: "Email", href: "/dashboard/tools/email", disabled: true, tag: "soon" },
      { name: "OTP", href: "/dashboard/tools/otp", disabled: true, tag: "soon" },
      { name: "Card", href: "/dashboard/tools/card", disabled: true, tag: "soon" },
    ],
  },
  { name: "Playground", href: "/dashboard/playground", icon: "i-lucide-flask-conical" },
];

interface ShellAccountSummary {
  accountCounts: ProviderAccountCounts;
  activeAccountCounts: ProviderAccountCounts;
  accountIndicators: ProviderAccountIndicators;
  pinnedProviders: ProviderAccountKey[];
  hasConnectedAccounts: boolean;
}

function toShellAccountSummary(summary: AccountOverviewData | AccountPingData): ShellAccountSummary {
  const nextAccountCounts = {} as ProviderAccountCounts;
  const nextActiveAccountCounts = {} as ProviderAccountCounts;
  const nextAccountIndicators = {} as ProviderAccountIndicators;
  let hasConnectedAccounts = "hasConnectedAccounts" in summary ? summary.hasConnectedAccounts : false;

  for (const definition of PROVIDER_ACCOUNT_DEFINITIONS) {
    const providerSummary = summary.summaries[definition.key];
    nextAccountCounts[definition.key] = 0;
    nextActiveAccountCounts[definition.key] = 0;
    nextAccountIndicators[definition.key] = "normal";
    if (!providerSummary) continue;
    const connected = "connected" in providerSummary ? providerSummary.connected : providerSummary.active;
    if (connected > 0) hasConnectedAccounts = true;
    nextAccountCounts[definition.key] = connected;
    nextActiveAccountCounts[definition.key] = providerSummary.active;
    nextAccountIndicators[definition.key] = providerSummary.indicator;
  }

  return {
    accountCounts: nextAccountCounts,
    activeAccountCounts: nextActiveAccountCounts,
    accountIndicators: nextAccountIndicators,
    pinnedProviders: summary.pinnedProviders,
    hasConnectedAccounts,
  };
}

function NavSidebar({
  accountSummary,
  modelFamilyCounts,
  sharingEnabled,
  sharingUpdating,
  isAuditMode,
  isMaintener,
  mobile,
  onNavigate,
  onToggleSharing,
}: {
  accountSummary: ShellAccountSummary | null;
  modelFamilyCounts: ModelFamilyCounts;
  sharingEnabled: boolean;
  sharingUpdating: boolean;
  isAuditMode: boolean;
  isMaintener: boolean;
  mobile?: boolean;
  onNavigate?: () => void;
  onToggleSharing: () => void;
}) {
  const location = useLocation();
  const [supportItemOpen, setSupportItemOpen] = useState<Record<string, boolean>>({ Tools: false });

  const accountCountByHref = useMemo(() => buildProviderHrefMap(accountSummary?.accountCounts ?? ({} as ProviderAccountCounts)), [accountSummary]);
  const activeAccountCountByHref = useMemo(() => buildProviderHrefMap(accountSummary?.activeAccountCounts ?? ({} as ProviderAccountCounts)), [accountSummary]);
  const accountIndicatorByHref = useMemo(() => buildProviderHrefMap(accountSummary?.accountIndicators ?? ({} as ProviderAccountIndicators)), [accountSummary]);
  const pinnedProviders = accountSummary?.pinnedProviders ?? [];
  const pinnedProviderHrefs = useMemo(() => {
    const hrefs = new Set<string>();
    pinnedProviders.forEach((key) => {
      const provider = PROVIDER_ACCOUNT_DEFINITIONS.find((definition) => definition.key === key);
      if (provider) hrefs.add(getProviderAccountPath(provider.key));
    });
    return hrefs;
  }, [pinnedProviders]);

  const isActive = (href: string) => {
    if (href === "/dashboard" && ["/dashboard/antigravity", "/dashboard/codex", "/dashboard/command_code", "/dashboard/kiro", "/dashboard/nvidia_nim", "/dashboard/openrouter", "/dashboard/qoder", "/dashboard/siliconflow", "/dashboard/workers_ai", "/dashboard/zenmux"].includes(location.pathname)) return true;
    return location.pathname === href || (href !== "/dashboard" && location.pathname.startsWith(href));
  };

  const isSubItemActive = (subItem: NavSubItem) => {
    if (subItem.anchorId) {
      return location.pathname === subItem.href && location.hash === `#${subItem.anchorId}`;
    }
    return location.pathname === subItem.href || location.pathname.startsWith(`${subItem.href}/`);
  };

  const isAccountsNavItem = (item: NavItem) => item.href === "/dashboard";

  const visibleSubItems = (item: NavItem) => {
    if (!item.children) return [];
    if (isAccountsNavItem(item)) {
      return item.children
        .filter((subItem) => pinnedProviderHrefs.has(subItem.href))
        .sort((a, b) => {
          const availabilityA = (activeAccountCountByHref[a.href] ?? 0) > 0 ? "active" : "inactive";
          const availabilityB = (activeAccountCountByHref[b.href] ?? 0) > 0 ? "active" : "inactive";
          const indicatorA = accountIndicatorByHref[a.href] ?? "normal";
          const indicatorB = accountIndicatorByHref[b.href] ?? "normal";
          return PROVIDER_AVAILABILITY_ORDER[availabilityA] - PROVIDER_AVAILABILITY_ORDER[availabilityB]
            || PROVIDER_STATUS_ORDER[indicatorA] - PROVIDER_STATUS_ORDER[indicatorB]
            || a.name.localeCompare(b.name);
        });
    }
    if (item.href === "/dashboard/models") {
      return item.children.filter((subItem) => (subItem.anchorId ? (modelFamilyCounts[subItem.anchorId] ?? 0) > 0 : true));
    }
    return item.children;
  };

  const renderSubItems = (item: NavItem) => {
    const subItems = visibleSubItems(item);
    if (subItems.length === 0) {
      return isAccountsNavItem(item) ? <p className="min-h-6 px-2.5 py-1.5 text-[11px] text-muted-foreground">No pinned providers.</p> : null;
    }
    return (
      <div className="ml-6 space-y-1 border-l border-border/60 pl-3">
        {subItems.map((subItem) => {
          const key = `${item.name}-${subItem.name}`;
          if (subItem.disabled) {
            return (
              <div key={key} className="flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground/60" aria-disabled="true">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{subItem.name}</span>
                  {subItem.tag ? <UiBadge variant="outline" className="border-border/40 bg-muted/20 px-1.5 py-0 text-[10px] lowercase text-muted-foreground/60">{subItem.tag}</UiBadge> : null}
                </span>
              </div>
            );
          }
          if (subItem.control === "switch") {
            return (
              <div key={key} className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs font-medium outline-none transition-colors text-muted-foreground hover:text-foreground/70" onClick={onToggleSharing}>
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate">{subItem.name}</span>
                  <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/60 transition-colors hover:text-foreground">
                    <UiIcon name="i-lucide-circle-question-mark" className="size-3 [stroke-width:1.5]" />
                  </span>
                </div>
                <UiSwitch checked={sharingEnabled} disabled={isAuditMode || sharingUpdating} size="sm" onCheckedChange={onToggleSharing} />
              </div>
            );
          }
          const href = subItem.anchorId ? `${subItem.href}#${subItem.anchorId}` : subItem.href;
          return (
            <Link
              key={key}
              to={href}
              onClick={onNavigate}
              className={cn("flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors", isSubItemActive(subItem) ? "text-foreground" : "text-muted-foreground hover:text-foreground/70")}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate">{subItem.name}</span>
                {subItem.tag ? <UiBadge variant="outline" className="px-1.5 py-0 text-[10px] lowercase">{subItem.tag}</UiBadge> : null}
              </span>
              {isAccountsNavItem(item) ? (
                <AccountStatusIndicator accountCount={accountCountByHref[subItem.href]} activeAccountCount={activeAccountCountByHref[subItem.href]} indicator={accountIndicatorByHref[subItem.href]} />
              ) : item.href === "/dashboard/models" && subItem.anchorId && (modelFamilyCounts[subItem.anchorId] ?? 0) > 0 ? (
                <span className={cn("px-1.5 py-0.5 text-[10px] font-semibold leading-none", isSubItemActive(subItem) ? "text-foreground" : "text-muted-foreground")}>
                  {modelFamilyCounts[subItem.anchorId]}
                </span>
              ) : null}
            </Link>
          );
        })}
      </div>
    );
  };

  return (
    <nav className="scrollbar-none min-h-0 flex-1 overflow-y-auto pr-1">
      <div className="space-y-1">
        {primaryNavigation.map((item) => (
          <div key={`${mobile ? "mobile-" : ""}${item.name}`} className="space-y-1">
            <Link
              to={item.href}
              onClick={onNavigate}
              className={cn("group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all", isActive(item.href) ? "text-foreground" : "text-muted-foreground hover:text-foreground/70")}
            >
              <UiIcon name={item.icon} className={cn("size-4", isActive(item.href) ? "text-foreground" : "text-muted-foreground group-hover:text-foreground/70")} />
              {item.name}
            </Link>
            {item.children?.length ? renderSubItems(item) : null}
          </div>
        ))}
      </div>

      <div className="mt-4 space-y-1 border-t border-border/60 pt-4">
        {supportNavigation.map((item) => {
          const itemOpen = !item.children?.length || supportItemOpen[item.name] !== false;
          return (
            <div key={`${mobile ? "mobile-" : ""}${item.name}`} className="space-y-1">
              {item.children?.length ? (
                <button
                  type="button"
                  aria-expanded={itemOpen}
                  className="group flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-all text-muted-foreground hover:text-foreground/70"
                  onClick={() => setSupportItemOpen((current) => ({ ...current, [item.name]: !itemOpen }))}
                >
                  <UiIcon name={item.icon} className="size-4 text-muted-foreground group-hover:text-foreground/70" />
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  <UiIcon name="i-lucide-chevron-down" className={cn("size-3.5 transition-transform", itemOpen ? "rotate-0" : "-rotate-90")} />
                </button>
              ) : (
                <Link
                  to={item.href}
                  aria-disabled={item.disabled}
                  onClick={onNavigate}
                  className={cn("group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all", item.disabled ? "cursor-default text-muted-foreground/45" : isActive(item.href) ? "text-foreground" : "text-muted-foreground hover:text-foreground/70")}
                >
                  <UiIcon name={item.icon} className={cn("size-4", item.disabled ? "text-muted-foreground/45" : isActive(item.href) ? "text-foreground" : "text-muted-foreground group-hover:text-foreground/70")} />
                  {item.name}
                </Link>
              )}
              {item.children?.length && itemOpen ? (
                <div className="ml-6 space-y-1 border-l border-border/60 pl-3">
                  {item.children.map((subItem) => {
                    const key = `${item.name}-${subItem.name}`;
                    if (subItem.disabled) {
                      return (
                        <div key={key} className="flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground/50" aria-disabled="true">
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate">{subItem.name}</span>
                            {subItem.tag ? <UiBadge variant="outline" className="border-border/40 bg-muted/20 px-1.5 py-0 text-[10px] lowercase text-muted-foreground/60">{subItem.tag}</UiBadge> : null}
                          </span>
                        </div>
                      );
                    }
                    return (
                      <Link
                        key={key}
                        to={subItem.href}
                        onClick={onNavigate}
                        className="flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors text-muted-foreground hover:text-foreground/70"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate">{subItem.name}</span>
                          {subItem.tag ? <UiBadge variant="outline" className="px-1.5 py-0 text-[10px] lowercase">{subItem.tag}</UiBadge> : null}
                        </span>
                      </Link>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </nav>
  );
}

export default function DashboardLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: session } = useSession();
  const dashboardApi = useDashboardApi();
  const dashboardInvalidation = useDashboardDataInvalidation();
  const { dashboardMe, auditUser, isAuditMode, refreshAfterAuditChange } = useDashboardAudit();

  const [mobileOpen, setMobileOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [modelSearchFocused, setModelSearchFocused] = useState(false);
  const [auditDialogOpen, setAuditDialogOpen] = useState(false);
  const [sharingEnabled, setSharingEnabled] = useState(false);
  const [sharingUpdating, setSharingUpdating] = useState(false);
  const [disableSharingDialogOpen, setDisableSharingDialogOpen] = useState(false);
  const [pointMenuOpen, setPointMenuOpen] = useState(false);
  const [accountSummary, setAccountSummary] = useState<ShellAccountSummary | null>(null);
  const [modelFamilyCounts, setModelFamilyCounts] = useState<ModelFamilyCounts>({});

  const accountsOverviewVersion = useDataVersion(dashboardInvalidation.keys.accountsOverview);
  const shellAccountsVersion = useDataVersion(dashboardInvalidation.keys.shellAccounts);
  const familyCountsVersion = useDataVersion(dashboardInvalidation.keys.shellModelFamilyCounts);

  const [polledPointBalance, setPolledPointBalance] = useState<number | null>(null);
  const isMaintener = dashboardMe?.isMaintener ?? false;
  const pointBalance = polledPointBalance ?? dashboardMe?.points?.balance ?? 0;
  const formattedPointBalance = pointBalance.toLocaleString("en-US");

  const userLabel = session?.user?.name || session?.user?.email || "Account";
  const userEmail = session?.user?.email || "";
  const userImage = session?.user?.image || "";
  const userInitial = (session?.user?.name?.[0] || "U").toUpperCase();
  const auditUserLabel = auditUser?.name || auditUser?.email || "Audit user";
  const auditUserEmail = auditUser?.email || "";
  const auditUserImage = auditUser?.image || "";
  const auditUserInitial = (auditUserLabel[0] || "U").toUpperCase();

  useEffect(() => {
    setSharingEnabled(dashboardMe?.sharing?.enabled ?? false);
  }, [dashboardMe]);

  useEffect(() => {
    void (async () => {
      try {
        const me = await dashboardApi.me.get();
        setSharingEnabled(me.sharing?.enabled ?? false);
      } catch {
        // ignore
      }
    })();
  }, [dashboardApi]);

  // Account summary (overview on dashboard root, ping elsewhere)
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const isOverviewRoute = location.pathname === "/dashboard";
        const summary = isOverviewRoute
          ? await dashboardApi.accounts.overview()
          : await dashboardApi.accounts.ping();
        if (!cancelled) setAccountSummary(toShellAccountSummary(summary));
      } catch {
        if (!cancelled) setAccountSummary(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dashboardApi, location.pathname, accountsOverviewVersion, shellAccountsVersion]);

  // Periodic account summary refresh
  useEffect(() => {
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const isOverviewRoute = location.pathname === "/dashboard";
          const summary = isOverviewRoute
            ? await dashboardApi.accounts.overview()
            : await dashboardApi.accounts.ping();
          setAccountSummary(toShellAccountSummary(summary));
        } catch {
          // ignore
        }
      })();
    }, ACCOUNT_SUMMARY_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [dashboardApi, location.pathname]);

  // Model family counts
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const counts = await dashboardApi.models.familyCounts();
        if (cancelled) return;
        const anchorByFamily = new Map(MODEL_FAMILY_NAV_ITEMS.map((family) => [family.name, family.anchorId]));
        const nextCounts: ModelFamilyCounts = {};
        for (const [rawFamily, count] of Object.entries(counts)) {
          const family = categorizeModelFamily(rawFamily);
          const anchorId = anchorByFamily.get(family);
          if (anchorId) nextCounts[anchorId] = (nextCounts[anchorId] ?? 0) + count;
        }
        setModelFamilyCounts(nextCounts);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dashboardApi, familyCountsVersion]);

  // Point status refresh
  useEffect(() => {
    const refresh = async () => {
      try {
        const status = await dashboardApi.points.status();
        setPolledPointBalance(status.balance);
      } catch {
        // ignore
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), POINT_STATUS_REFRESH_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboardApi]);

  const updateSharing = async (enabled: boolean) => {
    if (isAuditMode || sharingUpdating) return;
    setSharingUpdating(true);
    try {
      const result = await dashboardApi.sharing.update({ enabled });
      setSharingEnabled(result.enabled);
    } finally {
      setSharingUpdating(false);
    }
  };

  const toggleSharing = () => {
    if (isAuditMode || sharingUpdating) return;
    if (sharingEnabled) {
      setDisableSharingDialogOpen(true);
      return;
    }
    void updateSharing(true);
  };

  const handleSignOut = async () => {
    if (isAuditMode) {
      await dashboardApi.maintener.audit.stop();
      setUserMenuOpen(false);
      await refreshAfterAuditChange();
      return;
    }
    await signOut();
    navigate("/");
  };

  return (
    <div className="min-h-svh bg-background text-foreground">
      <div className="dashboard-layout-frame relative mx-auto flex min-h-svh w-full md:max-w-screen-md lg:max-w-screen-lg xl:max-w-screen-xl 2xl:max-w-[118rem] min-[1920px]:max-w-[128rem]">
        <aside className="sticky top-0 hidden border-r border-border bg-background md:flex md:h-svh md:w-60 md:shrink-0 md:flex-col">
          <div className="flex h-16 items-center border-b border-border px-6">
            <Link to="/dashboard" className="inline-flex items-center gap-2.5">
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inset-0 inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
              </span>
              <span className="inline-flex items-center gap-2 text-base font-semibold tracking-tight">
                Opendum
                {isMaintener ? (
                  <span className="rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none text-muted-foreground">dev</span>
                ) : null}
              </span>
            </Link>
          </div>

          <div className="flex min-h-0 flex-1 flex-col px-3 py-4">
            <NavSidebar
              accountSummary={accountSummary}
              modelFamilyCounts={modelFamilyCounts}
              sharingEnabled={sharingEnabled}
              sharingUpdating={sharingUpdating}
              isAuditMode={isAuditMode}
              isMaintener={isMaintener}
              onToggleSharing={toggleSharing}
            />
          </div>
        </aside>

        <div className="flex min-h-svh min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 h-16 border-b border-border bg-background px-3 sm:px-6 lg:px-8">
            <div className="flex h-full w-full items-center gap-3 md:gap-0">
              <div className="flex min-w-0 items-center">
                <button
                  type="button"
                  className="inline-flex size-11 cursor-pointer items-center justify-center text-foreground outline-none transition-colors hover:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 md:hidden"
                  onClick={() => setMobileOpen(true)}
                >
                  <UiIcon name="i-lucide-menu" className="size-8" />
                  <span className="sr-only">Toggle menu</span>
                </button>
              </div>

              <div className="min-w-0 flex-1">
                <ModelSearchPopover onFocusChange={setModelSearchFocused} />
              </div>

              <div className="flex items-center gap-1.5 sm:gap-2">
                <UiPopover open={userMenuOpen} onOpenChange={setUserMenuOpen} content={{ align: "end", sideOffset: 8, arrowClass: "translate-x-5" }} trigger={
                  <button
                    type="button"
                    aria-label="Open account menu"
                    className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-full px-1 transition-opacity hover:opacity-80"
                  >
                    <PointCoinIcon className={cn("size-6 shrink-0 text-foreground/85 drop-shadow-[0_0_0.35rem_rgba(255,255,255,0.18)]", modelSearchFocused ? "hidden sm:block" : "")} />
                    <span className={cn("select-none text-sm font-semibold tabular-nums text-foreground/85", modelSearchFocused ? "hidden sm:inline" : "")}>{formattedPointBalance}</span>
                    <span className="relative flex size-8 shrink-0 select-none sm:ml-1">
                      <span className="flex size-8 overflow-hidden rounded-full">
                        {userImage ? <img src={userImage} alt="" className="aspect-square size-full" /> : <span className="flex size-full items-center justify-center rounded-full bg-muted text-sm text-muted-foreground">{userInitial}</span>}
                      </span>
                      {isAuditMode ? (
                        <span className="absolute -bottom-1 -left-1 flex size-5 overflow-hidden rounded-full border-2 border-background bg-muted ring-1 ring-border">
                          {auditUserImage ? <img src={auditUserImage} alt="" className="aspect-square size-full" /> : <span className="flex size-full items-center justify-center text-[9px] font-semibold text-muted-foreground">{auditUserInitial}</span>}
                        </span>
                      ) : null}
                    </span>
                  </button>
                }>
                  <div className="w-64 max-w-[calc(100vw-2rem)] p-1">
                    <div className="px-2 py-1.5 text-sm font-medium">
                      <div className="flex flex-col">
                        <span className="truncate">{userLabel}</span>
                        <span className="truncate text-xs text-muted-foreground">{userEmail}</span>
                      </div>
                    </div>
                    {isAuditMode ? (
                      <div className="mx-1 mt-1 mb-2 rounded-md border border-border/70 bg-muted/30 px-2 py-2 text-sm">
                        <div className="space-y-0.5">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Auditing</p>
                            <UiTooltip text="Change">
                              <button
                                type="button"
                                aria-label="Change"
                                className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border/70 bg-background/80 text-muted-foreground shadow-xs outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                                onClick={() => {
                                  setUserMenuOpen(false);
                                  setAuditDialogOpen(true);
                                }}
                              >
                                <UiIcon name="i-lucide-refresh-cw" className="size-3.5" />
                              </button>
                            </UiTooltip>
                          </div>
                          <div className="min-w-0">
                            <p className="truncate font-medium">{auditUserLabel}</p>
                            <p className="truncate text-xs text-muted-foreground">{auditUserEmail}</p>
                          </div>
                        </div>
                      </div>
                    ) : null}
                    <div className="-mx-1 my-2 h-px bg-border" />
                    <div className="space-y-1">
                      <button
                        type="button"
                        aria-expanded={pointMenuOpen}
                        className="group flex w-full cursor-pointer items-center gap-3 rounded-sm px-2 py-1.5 text-left text-sm font-medium text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
                        onClick={() => setPointMenuOpen(!pointMenuOpen)}
                      >
                        <span className="min-w-0 flex-1">Point</span>
                        <UiIcon name="i-lucide-chevron-down" className={cn("size-3.5 transition-transform", pointMenuOpen ? "rotate-0" : "-rotate-90")} />
                      </button>
                      {pointMenuOpen ? (
                        <div className="ml-3 space-y-1 border-l border-border/60 pl-3">
                          <div className="flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground/50" aria-disabled="true">
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="truncate">Topup</span>
                              <UiBadge variant="outline" className="border-border/40 bg-muted/20 px-1.5 py-0 text-[10px] lowercase text-muted-foreground/60">soon</UiBadge>
                            </span>
                          </div>
                          <div className="flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground/50" aria-disabled="true">
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="truncate">Withdraw</span>
                              <UiBadge variant="outline" className="border-border/40 bg-muted/20 px-1.5 py-0 text-[10px] lowercase text-muted-foreground/60">soon</UiBadge>
                            </span>
                          </div>
                        </div>
                      ) : null}
                    </div>
                    {isMaintener && !isAuditMode ? (
                      <button
                        type="button"
                        className="relative flex w-full cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
                        onClick={() => {
                          setUserMenuOpen(false);
                          setAuditDialogOpen(true);
                        }}
                      >
                        Auditing
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="relative flex w-full cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
                      onClick={() => void handleSignOut()}
                    >
                      Sign out
                    </button>
                  </div>
                </UiPopover>
              </div>
            </div>
          </header>

          <main className="flex-1">
            <div className="w-full px-5 pb-8 pt-5 sm:px-6 lg:px-8">
              <Outlet />
            </div>
          </main>
        </div>
      </div>

      <UiSheet
        open={mobileOpen}
        onOpenChange={setMobileOpen}
        side="left"
        ui={{ overlay: "touch-none", content: "w-[78vw] max-w-[18rem] p-0" }}
      >
        <div className="flex h-full flex-col bg-background">
          <div className="flex h-16 items-center justify-between border-b border-border px-6">
            <Link to="/dashboard" className="inline-flex items-center gap-2 text-base font-semibold tracking-tight" onClick={() => setMobileOpen(false)}>
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inset-0 inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
              </span>
              <span className="inline-flex items-center gap-2">
                Opendum
                {isMaintener ? <span className="rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none text-muted-foreground">dev</span> : null}
              </span>
            </Link>
            <button type="button" className="cursor-pointer opacity-70 transition-opacity hover:opacity-100 focus:outline-none" onClick={() => setMobileOpen(false)}>
              <UiIcon name="i-lucide-x" className="size-4" />
              <span className="sr-only">Close</span>
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col px-3 py-4">
            <NavSidebar
              mobile
              accountSummary={accountSummary}
              modelFamilyCounts={modelFamilyCounts}
              sharingEnabled={sharingEnabled}
              sharingUpdating={sharingUpdating}
              isAuditMode={isAuditMode}
              isMaintener={isMaintener}
              onNavigate={() => setMobileOpen(false)}
              onToggleSharing={toggleSharing}
            />
          </div>
        </div>
      </UiSheet>

      <UiDialog open={disableSharingDialogOpen} onOpenChange={setDisableSharingDialogOpen} ui={{ content: "sm:max-w-[400px]" }}>
        <div className="space-y-1.5 pr-6">
          <h2 className="text-lg font-semibold leading-none tracking-tight">Stop Sharing</h2>
          <p className="text-sm text-muted-foreground">You won't earn points anymore?</p>
        </div>
        <div className="flex justify-end gap-2">
          <UiButton variant="outline" size="sm" onClick={() => setDisableSharingDialogOpen(false)}>Cancel</UiButton>
          <UiButton variant="destructive" size="sm" onClick={() => { setDisableSharingDialogOpen(false); void updateSharing(false); }}>Stop</UiButton>
        </div>
      </UiDialog>

      <MaintenerAuditDialog open={auditDialogOpen} onOpenChange={setAuditDialogOpen} onSelected={() => void refreshAfterAuditChange()} />
    </div>
  );
}
