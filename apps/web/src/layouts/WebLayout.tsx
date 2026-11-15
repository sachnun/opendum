import { createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { A, useLocation, useNavigate } from "@solidjs/router";
import { AccountStatusIndicator } from "~/components/account/AccountStatusIndicator";
import { MaintainerAuditDialog } from "~/components/maintainer/MaintainerAuditDialog";
import { ModelSearchPopover } from "~/components/model/ModelSearchPopover";
import { PointCoinIcon } from "~/components/common/PointCoinIcon";
import { UiBadge } from "~/components/ui/UiBadge";
import { UiButton } from "~/components/ui/UiButton";
import { UiDialog } from "~/components/ui/UiDialog";
import { UiIcon } from "~/components/ui/UiIcon";
import { UiPopover } from "~/components/ui/UiPopover";
import { UiSheet } from "~/components/ui/UiSheet";
import { UiTooltip } from "~/components/ui/UiTooltip";
import { asButtonProps } from "~/components/ui/trigger";
import { emptyCounts, emptySummary, familyCounts, toSummary, type ShellAccountSummary } from "~/lib/account-overview";
import { auditUser, isAuditMode, refreshAfterAudit, syncMeFromQuery } from "~/lib/audit";
import { signOut as endSession } from "~/lib/auth";
import { createAnchorNavigation } from "~/lib/anchor-navigation";
import { createMobileSidebar } from "~/lib/mobile-sidebar";
import { dataKeys } from "~/lib/data-keys";
import { invalidation } from "~/lib/invalidate";
import { isSwitch, primaryNavigation, hrefOf, type NavItem, type NavSubItem, type ProviderAccountIndicator } from "~/lib/navigation";
import { createQuery, queryEntry } from "~/lib/query";
import { isHome, Routes } from "~/lib/routes";
import { avatarUrl } from "~/lib/utils";
import { useLiveEvent } from "~/lib/live-event";
import { startEventStream } from "~/lib/event-stream";
import { api } from "~/api";
import { compareText } from "@opendum/models/compare";
import { accountPath, hrefMap, PROVIDER_ACCOUNT_DEFINITIONS } from "@opendum/providers/provider-accounts";
import type { AccountsData, ModelsData, UsageData } from "@opendum/providers/contract";
import type { AccountOverviewData, MeData } from "~/lib/api-types";

const PROVIDER_AVAILABILITY_ORDER = { active: 0, inactive: 1 } as const;
const PROVIDER_STATUS_ORDER = { error: 0, warning: 1, normal: 2 } as const;

export function WebLayout(props: { children?: JSX.Element }): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const sidebar = createMobileSidebar();

  const [userMenuOpen, setUserMenuOpen] = createSignal(false);
  const [modelSearchFocused, setModelSearchFocused] = createSignal(false);
  const [auditDialogOpen, setAuditDialogOpen] = createSignal(false);
  const [sharingEnabled, setSharingEnabled] = createSignal(false);
  const [sharingUpdating, setSharingUpdating] = createSignal(false);
  const [sharingDialog, setSharingDialog] = createSignal(false);
  const [supportItemOpen, setSupportItemOpen] = createSignal<Record<string, boolean>>({ Tools: false });
  const [pointMenuOpen, setPointMenuOpen] = createSignal(false);

  const meQuery = createQuery<MeData>(dataKeys.me, () => api.me.get(), {
    defaultValue: { role: "user" as const, isMaintainer: false },
  });
  const customProvidersQuery = createQuery(dataKeys.customProviders, () => api.customProviders.list(), { defaultValue: [] });
  const accountsOverviewEntry = () => queryEntry<AccountOverviewData>(dataKeys.accountsOverview);
  const shellAccountsQuery = createQuery<ShellAccountSummary>(
    dataKeys.shellAccounts,
    async () => toSummary(accountsOverviewEntry()?.data() ?? (await api.accounts.ping())),
    { defaultValue: emptySummary, immediate: false }
  );
  const shellFamilyCountsQuery = createQuery(dataKeys.shellModelFamilyCounts, async () => familyCounts(await api.models.familyCounts()), {
    defaultValue: emptyCounts,
  });

  const me = () => meQuery.data() ?? null;
  const customProviders = () => customProvidersQuery.data() ?? [];
  const isMaintainer = () => me()?.isMaintainer ?? false;
  const pointBalance = () => me()?.points?.balance ?? 0;
  const formattedPointBalance = () => pointBalance().toLocaleString("en-US");
  const currentUser = () => me()?.actor ?? null;
  const userLabel = () => currentUser()?.name || currentUser()?.email || "Account";
  const userEmail = () => currentUser()?.email || "";
  const userImage = () => avatarUrl(currentUser()?.image || "");
  const userInitial = () => (currentUser()?.name?.[0] || "U").toUpperCase();
  const auditUserLabel = () => auditUser()?.name || auditUser()?.email || "Audit user";
  const auditUserEmail = () => auditUser()?.email || "";
  const auditUserImage = () => avatarUrl(auditUser()?.image || "");
  const auditUserInitial = () => (auditUserLabel()[0] || "U").toUpperCase();

  const supportNavigation = (): NavItem[] => [
    {
      name: "Tools",
      href: "/tools",
      icon: "i-lucide-wrench",
      children: [
        { name: "Email", href: "/tools/email", disabled: true, tag: "soon" },
        { name: "OTP", href: "/tools/otp", disabled: true, tag: "soon" },
        { name: "Card", href: "/tools/card", disabled: true, tag: "soon" },
      ],
    },
    { name: "Playground", href: Routes.playground, icon: "i-lucide-flask-conical" },
  ];

  const accountsNavigationHref = Routes.home;
  const hrefByKey = () =>
    Object.fromEntries([
      ...PROVIDER_ACCOUNT_DEFINITIONS.map((definition) => [definition.key, accountPath(definition.key)]),
      ...customProviders().map((provider) => [provider.slug, accountPath(provider.slug)]),
    ]);

  const navigation = (): NavItem[] =>
    primaryNavigation.map((item) =>
      item.href === accountsNavigationHref
        ? {
            ...item,
            children: [
              ...[...PROVIDER_ACCOUNT_DEFINITIONS]
                .sort((a, b) => (a.navOrder ?? Number.MAX_SAFE_INTEGER) - (b.navOrder ?? Number.MAX_SAFE_INTEGER))
                .map((definition) => ({ name: definition.label, href: accountPath(definition.key) })),
              ...customProviders().map((provider) => ({ name: provider.name, href: accountPath(provider.slug) })),
            ],
          }
        : item
    );

  const summary = (): ShellAccountSummary => {
    const overview = accountsOverviewEntry()?.data();
    return overview ? toSummary(overview) : (shellAccountsQuery.data() ?? emptySummary);
  };
  const accountCounts = () => summary().accountCounts;
  const activeAccountCounts = () => summary().activeAccountCounts;
  const accountIndicators = () => summary().accountIndicators;
  const pinnedProviders = () => summary().pinnedProviders;
  const modelFamilyCounts = () => shellFamilyCountsQuery.data() ?? emptyCounts;

  function customCounts<V>(counts: Record<string, V>): Record<string, V> {
    const result: Record<string, V> = {};
    for (const provider of customProviders()) {
      const value = counts[provider.slug];
      if (value !== undefined) result[accountPath(provider.slug)] = value;
    }
    return result;
  }

  const activeByHref = () => ({ ...hrefMap(activeAccountCounts()), ...customCounts(activeAccountCounts()) });
  const countByHref = () => ({ ...hrefMap(accountCounts()), ...customCounts(accountCounts()) });
  const indicatorByHref = () => ({ ...hrefMap(accountIndicators()), ...customCounts(accountIndicators()) });

  const accountNavigationHrefs = () =>
    new Set([
      ...PROVIDER_ACCOUNT_DEFINITIONS.map((definition) => accountPath(definition.key)),
      ...customProviders().map((provider) => accountPath(provider.slug)),
    ]);

  const pinnedProviderHrefs = () => {
    const hrefs = new Set<string>();
    pinnedProviders().forEach((key) => {
      const href = hrefByKey()[key];
      if (href) hrefs.add(href);
    });
    return hrefs;
  };

  const sheetContentStyle = () => {
    if (sidebar.dragX() === 0) return undefined;
    return {
      transform: `translateX(${sidebar.dragX()}px)`,
      transition: sidebar.isDragging() ? "none" : undefined,
    } as JSX.CSSProperties;
  };

  const sheetOverlayStyle = () => {
    if (sidebar.dragX() === 0) return undefined;
    return { opacity: Math.max(0.35, 1 - Math.abs(sidebar.dragX()) / 320) } as JSX.CSSProperties;
  };

  function isActive(href: string) {
    if (href === accountsNavigationHref) return isHome(location.pathname) || accountNavigationHrefs().has(location.pathname);
    return location.pathname === href || location.pathname.startsWith(href);
  }

  function accountsItem(item: NavItem) {
    return item.href === accountsNavigationHref;
  }

  function supportActive(item: NavItem) {
    return isActive(item.href) || Boolean(item.children?.some((subItem) => subActive(subItem)));
  }

  function supportOpen(item: NavItem) {
    return !item.children?.length || supportItemOpen()[item.name] !== false;
  }

  function toggleSupport(item: NavItem) {
    if (!item.children?.length) return;
    setSupportItemOpen({ ...supportItemOpen(), [item.name]: !supportOpen(item) });
  }

  function subActive(subItem: NavSubItem) {
    if (subItem.anchorId) {
      const current = anchorNav.activeAnchorId();
      return location.pathname === subItem.href && (current ? current === subItem.anchorId : location.hash === `#${subItem.anchorId}`);
    }
    return location.pathname === subItem.href || location.pathname.startsWith(`${subItem.href}/`);
  }

  function subItems(item: NavItem): NavSubItem[] {
    if (!item.children) return [];

    if (accountsItem(item)) {
      return item.children
        .filter((subItem) => pinnedProviderHrefs().has(subItem.href))
        .sort((a, b) => {
          const availabilityA = (activeByHref()[a.href] ?? 0) > 0 ? "active" : "inactive";
          const availabilityB = (activeByHref()[b.href] ?? 0) > 0 ? "active" : "inactive";
          const indicatorA = indicatorByHref()[a.href] ?? "normal";
          const indicatorB = indicatorByHref()[b.href] ?? "normal";
          return (
            PROVIDER_AVAILABILITY_ORDER[availabilityA] - PROVIDER_AVAILABILITY_ORDER[availabilityB] ||
            PROVIDER_STATUS_ORDER[indicatorA] - PROVIDER_STATUS_ORDER[indicatorB] ||
            compareText(a.name, b.name)
          );
        });
    }

    if (item.href === Routes.models) {
      return item.children.filter((subItem) => (subItem.anchorId ? (modelFamilyCounts()[subItem.anchorId] ?? 0) > 0 : true));
    }

    return item.children;
  }

  function modelsFor(subItem: NavSubItem) {
    return subItem.anchorId ? (modelFamilyCounts()[subItem.anchorId] ?? 0) : 0;
  }

  function toggleDisabled(subItem: NavSubItem) {
    return isSwitch(subItem) && (isAuditMode() || sharingUpdating());
  }

  async function updateSharing(enabled: boolean) {
    if (isAuditMode() || sharingUpdating()) return;

    setSharingUpdating(true);
    const result = await api.sharing.update({ enabled });
    setSharingEnabled(result.enabled);
    const current = me();
    if (current) meQuery.setData({ ...current, sharing: { enabled: result.enabled } });
    setSharingUpdating(false);
  }

  function toggleSharing() {
    if (isAuditMode() || sharingUpdating()) return;

    if (sharingEnabled()) {
      setSharingDialog(true);
      return;
    }

    void updateSharing(true);
  }

  function disableSharing() {
    setSharingDialog(false);
    void updateSharing(false);
  }

  const anchorIds = () =>
    primaryNavigation.flatMap((item) =>
      subItems(item)
        .filter((subItem) => subItem.href === location.pathname && subItem.anchorId)
        .map((subItem) => subItem.anchorId as string)
    );

  const anchorNav = createAnchorNavigation({
    anchorIds,
    path: () => location.pathname,
    hash: () => location.hash,
    onNavigate: () => sidebar.closeMobileSidebar(),
  });

  function applyOverview(next: AccountOverviewData): void {
    accountsOverviewEntry()?.setData(next);
  }

  useLiveEvent("accounts", (data: AccountsData) => applyOverview(data.overview));
  useLiveEvent("usage", (data: UsageData) => {
    applyOverview(data.overview);
    invalidation.patchRoaming(data.roamingByKey);
  });
  useLiveEvent("models", (data: ModelsData) => invalidation.patchModels(data.list));

  let stopStream: (() => void) | null = null;

  onMount(() => {
    syncMeFromQuery();
    setSharingEnabled(me()?.sharing?.enabled ?? false);
    const fallback = setTimeout(() => {
      if (!accountsOverviewEntry()) void shellAccountsQuery.load();
    }, 0);
    stopStream = startEventStream({
      onPoints: (balance) => {
        const current = me();
        if (current) meQuery.setData({ ...current, points: { balance } });
      },
      onAccounts: (data) => applyOverview(data.overview),
      onUsage: (data) => {
        applyOverview(data.overview);
        invalidation.patchRoaming(data.roamingByKey);
      },
      onModels: (data) => invalidation.patchModels(data.list),
    });
    onCleanup(() => clearTimeout(fallback));
  });

  onCleanup(() => {
    sidebar.resetSwipe();
    stopStream?.();
  });

  async function signOut() {
    if (isAuditMode()) {
      await api.maintainer.audit.stop();
      setUserMenuOpen(false);
      await refreshAfterAudit();
      return;
    }

    await endSession();
    navigate("/");
  }

  function openAudit() {
    setUserMenuOpen(false);
    setAuditDialogOpen(true);
  }

  async function auditSelected() {
    await refreshAfterAudit();
  }

  const BrandMark = () => (
    <span class="relative flex h-2.5 w-2.5">
      <span class="absolute inset-0 inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
      <span class="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
    </span>
  );

  return (
    <div class="min-h-svh bg-background text-foreground">
      <div class="web-layout-frame relative mx-auto flex min-h-svh w-full md:max-w-screen-md lg:max-w-screen-lg xl:max-w-screen-xl 2xl:max-w-[118rem] min-[1920px]:max-w-[128rem]">
        <aside class="sticky top-0 hidden border-r border-border bg-background md:flex md:h-svh md:w-60 md:shrink-0 md:flex-col">
          <div class="flex h-16 items-center border-b border-border px-6">
            <A href="/" class="inline-flex items-center gap-2.5">
              <BrandMark />
              <span class="inline-flex items-center gap-2 text-base font-semibold tracking-tight">
                Opendum
                {isMaintainer() && (
                  <span class="rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none text-muted-foreground">
                    dev
                  </span>
                )}
              </span>
            </A>
          </div>

          <div class="flex min-h-0 flex-1 flex-col px-3 py-4">
            <nav class="scrollbar-none min-h-0 flex-1 overflow-y-auto pr-1">
              <div class="space-y-1">
                {navigation().map((item) => (
                  <div class="space-y-1">
                    <A
                      href={item.href}
                      class={`group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all ${
                        isActive(item.href) ? "text-foreground" : "text-muted-foreground hover:text-foreground/70"
                      }`}
                      onClick={(event) => anchorNav.handleNavClick(item, event)}
                    >
                      <UiIcon
                        name={item.icon}
                        class={`size-4 ${isActive(item.href) ? "text-foreground" : "text-muted-foreground group-hover:text-foreground/70"}`}
                      />
                      {item.name}
                    </A>

                    {item.children?.length ? (
                      <div class="ml-6 space-y-1 border-l border-border/60 pl-3">
                        {subItems(item).length > 0 ? (
                          subItems(item).map((subItem) => (
                            <SubItemLink
                              item={item}
                              subItem={subItem}
                              subActive={subActive(subItem)}
                              onNavClick={anchorNav.handleNavClick}
                              countByHref={countByHref()}
                              activeByHref={activeByHref()}
                              indicatorByHref={indicatorByHref()}
                              modelsFor={modelsFor}
                              sharingEnabled={sharingEnabled()}
                              toggleDisabled={toggleDisabled(subItem)}
                              toggleSharing={toggleSharing}
                            />
                          ))
                        ) : accountsItem(item) ? (
                          <p class="min-h-6 px-2.5 py-1.5 text-[11px] text-muted-foreground">No pinned providers.</p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </nav>

            <div class="shrink-0">
              <nav class="mt-4 space-y-1 border-t border-border/60 pt-4">
                {supportNavigation().map((item) => (
                  <div class="space-y-1">
                    {item.children?.length ? (
                      <button
                        type="button"
                        aria-expanded={supportOpen(item)}
                        class={`group flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-all ${
                          supportActive(item) ? "text-foreground" : "text-muted-foreground hover:text-foreground/70"
                        }`}
                        onClick={() => toggleSupport(item)}
                      >
                        <UiIcon
                          name={item.icon}
                          class={`size-4 ${supportActive(item) ? "text-foreground" : "text-muted-foreground group-hover:text-foreground/70"}`}
                        />
                        <span class="min-w-0 flex-1 truncate">{item.name}</span>
                        <UiIcon
                          name="i-lucide-chevron-down"
                          class={`size-3.5 transition-transform ${supportOpen(item) ? "rotate-0" : "-rotate-90"}`}
                        />
                      </button>
                    ) : (
                      <A
                        href={item.href}
                        aria-disabled={item.disabled ? true : undefined}
                        class={`group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all ${
                          item.disabled
                            ? "cursor-default text-muted-foreground/45"
                            : isActive(item.href)
                              ? "text-foreground"
                              : "text-muted-foreground hover:text-foreground/70"
                        }`}
                        onClick={(event) => anchorNav.handleNavClick(item, event)}
                      >
                        <UiIcon
                          name={item.icon}
                          class={`size-4 ${
                            item.disabled
                              ? "text-muted-foreground/45"
                              : isActive(item.href)
                                ? "text-foreground"
                                : "text-muted-foreground group-hover:text-foreground/70"
                          }`}
                        />
                        {item.name}
                      </A>
                    )}

                    {item.children?.length && supportOpen(item) ? (
                      <div class="ml-6 space-y-1 border-l border-border/60 pl-3">
                        {item.children.map((subItem) =>
                          subItem.disabled ? (
                            <div
                              class="flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground/50"
                              aria-disabled="true"
                            >
                              <span class="flex min-w-0 items-center gap-2">
                                <span class="truncate">{subItem.name}</span>
                                {subItem.tag && (
                                  <UiBadge
                                    variant="outline"
                                    class="border-border/40 bg-muted/20 px-1.5 py-0 text-[10px] lowercase text-muted-foreground/60"
                                  >
                                    {subItem.tag}
                                  </UiBadge>
                                )}
                              </span>
                            </div>
                          ) : (
                            <A
                              href={hrefOf(subItem)}
                              class={`flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                                subActive(subItem) ? "text-foreground" : "text-muted-foreground hover:text-foreground/70"
                              }`}
                              onClick={(event) => anchorNav.handleNavClick(subItem, event)}
                            >
                              <span class="flex min-w-0 items-center gap-2">
                                <span class="truncate">{subItem.name}</span>
                                {subItem.tag && (
                                  <UiBadge variant="outline" class="px-1.5 py-0 text-[10px] lowercase">
                                    {subItem.tag}
                                  </UiBadge>
                                )}
                              </span>
                            </A>
                          )
                        )}
                      </div>
                    ) : null}
                  </div>
                ))}
              </nav>
            </div>
          </div>
        </aside>

        <div class="flex min-h-svh min-w-0 flex-1 flex-col">
          <header class="sticky top-0 z-30 h-16 border-b border-border bg-background px-3 sm:px-6 lg:px-8">
            <div class="flex h-full w-full items-center gap-3 md:gap-0">
              <div class="flex min-w-0 items-center">
                <button
                  type="button"
                  class="inline-flex size-11 cursor-pointer items-center justify-center text-foreground outline-none transition-colors hover:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 md:hidden"
                  onClick={sidebar.openMobileSidebar}
                >
                  <UiIcon name="i-lucide-menu" class="size-8" />
                  <span class="sr-only">Toggle menu</span>
                </button>
              </div>

              <div class="min-w-0 flex-1">
                <ModelSearchPopover onFocusChange={setModelSearchFocused} />
              </div>

              <div class="flex items-center gap-1.5 sm:gap-2">
                <UiPopover
                  open={userMenuOpen()}
                  onOpenChange={setUserMenuOpen}
                  align="end"
                  sideOffset={8}
                  arrowClass="translate-x-5"
                  trigger={(triggerProps) => (
                    <button
                      {...asButtonProps(triggerProps)}
                      type="button"
                      class="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-full px-1 transition-opacity hover:opacity-80"
                    >
                      <span class="sr-only">Open account menu</span>
                      <PointCoinIcon
                        class={`size-6 shrink-0 text-foreground/85 drop-shadow-[0_0_0.35rem_rgba(255,255,255,0.18)] ${
                          modelSearchFocused() ? "hidden sm:block" : ""
                        }`}
                      />
                      <span
                        class={`select-none text-sm font-semibold tabular-nums text-foreground/85 ${
                          modelSearchFocused() ? "hidden sm:inline" : ""
                        }`}
                      >
                        {formattedPointBalance()}
                      </span>
                      <span class="relative flex size-8 shrink-0 select-none sm:ml-1">
                        <span class="flex size-8 overflow-hidden rounded-full">
                          {userImage() ? (
                            <img src={userImage()} alt="" class="aspect-square size-full" />
                          ) : (
                            <span class="flex size-full items-center justify-center rounded-full bg-muted text-sm text-muted-foreground">
                              {userInitial()}
                            </span>
                          )}
                        </span>
                        {isAuditMode() && (
                          <span class="absolute -bottom-1 -left-1 flex size-5 overflow-hidden rounded-full border-2 border-background bg-muted ring-1 ring-border">
                            {auditUserImage() ? (
                              <img src={auditUserImage()} alt="" class="aspect-square size-full" />
                            ) : (
                              <span class="flex size-full items-center justify-center text-[9px] font-semibold text-muted-foreground">
                                {auditUserInitial()}
                              </span>
                            )}
                          </span>
                        )}
                      </span>
                    </button>
                  )}
                  content={
                    <div class="w-64 max-w-[calc(100vw-2rem)] p-1">
                      <div class="px-2 py-1.5 text-sm font-medium">
                        <div class="flex flex-col">
                          <span class="truncate">{userLabel()}</span>
                          <span class="truncate text-xs text-muted-foreground">{userEmail()}</span>
                        </div>
                      </div>
                      {isAuditMode() && (
                        <div class="mx-1 mt-1 mb-2 rounded-md border border-border/70 bg-muted/30 px-2 py-2 text-sm">
                          <div class="space-y-0.5">
                            <div class="flex items-center justify-between gap-2">
                              <p class="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Auditing</p>
                              <UiTooltip text="Change" side="left" align="center">
                                <button
                                  type="button"
                                  aria-label="Change"
                                  class="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border/70 bg-background/80 text-muted-foreground shadow-xs outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                                  onClick={openAudit}
                                >
                                  <UiIcon name="i-lucide-refresh-cw" class="size-3.5" />
                                </button>
                              </UiTooltip>
                            </div>
                            <div class="min-w-0">
                              <p class="truncate font-medium">{auditUserLabel()}</p>
                              <p class="truncate text-xs text-muted-foreground">{auditUserEmail()}</p>
                            </div>
                          </div>
                        </div>
                      )}
                      <div class="-mx-1 my-2 h-px bg-border" />
                      <div class="space-y-1">
                        <button
                          type="button"
                          aria-expanded={pointMenuOpen()}
                          class="group flex w-full cursor-pointer items-center gap-3 rounded-sm px-2 py-1.5 text-left text-sm font-medium text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
                          onClick={() => setPointMenuOpen(!pointMenuOpen())}
                        >
                          <span class="min-w-0 flex-1">Points</span>
                          <UiIcon
                            name="i-lucide-chevron-down"
                            class={`size-3.5 transition-transform ${pointMenuOpen() ? "rotate-0" : "-rotate-90"}`}
                          />
                        </button>
                        {pointMenuOpen() && (
                          <div class="ml-3 space-y-1 border-l border-border/60 pl-3">
                            {["Topup", "Withdraw"].map((label) => (
                              <div
                                class="flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground/50"
                                aria-disabled="true"
                              >
                                <span class="flex min-w-0 items-center gap-2">
                                  <span class="truncate">{label}</span>
                                  <UiBadge
                                    variant="outline"
                                    class="border-border/40 bg-muted/20 px-1.5 py-0 text-[10px] lowercase text-muted-foreground/60"
                                  >
                                    soon
                                  </UiBadge>
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      {isMaintainer() && !isAuditMode() && (
                        <button
                          type="button"
                          class="relative flex w-full cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
                          onClick={openAudit}
                        >
                          Auditing
                        </button>
                      )}
                      <button
                        type="button"
                        class="relative flex w-full cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
                        onClick={() => void signOut()}
                      >
                        Sign out
                      </button>
                    </div>
                  }
                />
              </div>
            </div>
          </header>

          <main ref={anchorNav.setMainContent} class="flex-1">
            <div class="w-full px-5 pb-8 pt-5 sm:px-6 lg:px-8">{props.children}</div>
          </main>
        </div>
      </div>

      <UiSheet
        open={sidebar.mobileOpen()}
        onOpenChange={(open) => (open ? sidebar.openMobileSidebar() : sidebar.closeMobileSidebar())}
        side="left"
        ui={{ overlay: "touch-none", content: "w-[78vw] max-w-[18rem] p-0" }}
        overlayStyle={sheetOverlayStyle()}
        contentStyle={sheetContentStyle()}
        onOverlayClick={sidebar.overlayClick}
        onOverlayPointerDown={sidebar.overlayPointerDown}
        onOverlayPointerMove={sidebar.overlayPointerMove}
        onOverlayPointerUp={sidebar.finishSwipe}
        onOverlayPointerCancel={sidebar.finishSwipe}
        onContentPointerDownOutside={sidebar.sheetPointerDown}
        content={
          <div class="flex h-full flex-col bg-background">
            <div class="flex h-16 items-center justify-between border-b border-border px-6">
              <A href="/" class="inline-flex items-center gap-2 text-base font-semibold tracking-tight" onClick={() => sidebar.closeMobileSidebar()}>
                <BrandMark />
                <span class="inline-flex items-center gap-2">
                  Opendum
                  {isMaintainer() && (
                    <span class="rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none text-muted-foreground">
                      dev
                    </span>
                  )}
                </span>
              </A>
              <button
                type="button"
                class="cursor-pointer opacity-70 transition-opacity hover:opacity-100 focus:outline-none"
                onClick={() => sidebar.closeMobileSidebar()}
              >
                <UiIcon name="i-lucide-x" class="size-4" />
                <span class="sr-only">Close</span>
              </button>
            </div>

            <div class="flex min-h-0 flex-1 flex-col px-3 py-4">
              <nav class="scrollbar-none min-h-0 flex-1 overflow-y-auto pr-1">
                <div class="space-y-1">
                  {navigation().map((item) => (
                    <div class="space-y-1">
                      <A
                        href={item.href}
                        class={`group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all ${
                          isActive(item.href) ? "text-foreground" : "text-muted-foreground hover:text-foreground/70"
                        }`}
                        onClick={(event) => anchorNav.handleNavClick(item, event)}
                      >
                        <UiIcon
                          name={item.icon}
                          class={`size-4 ${isActive(item.href) ? "text-foreground" : "text-muted-foreground group-hover:text-foreground/70"}`}
                        />
                        {item.name}
                      </A>

                      {item.children?.length ? (
                        <div class="ml-6 space-y-1 border-l border-border/60 pl-3">
                          {subItems(item).length > 0 ? (
                            subItems(item).map((subItem) => (
                              <SubItemLink
                                item={item}
                                subItem={subItem}
                                subActive={subActive(subItem)}
                                onNavClick={anchorNav.handleNavClick}
                                countByHref={countByHref()}
                                activeByHref={activeByHref()}
                                indicatorByHref={indicatorByHref()}
                                modelsFor={modelsFor}
                                sharingEnabled={sharingEnabled()}
                                toggleDisabled={toggleDisabled(subItem)}
                                toggleSharing={toggleSharing}
                              />
                            ))
                          ) : accountsItem(item) ? (
                            <p class="min-h-6 px-2.5 py-1.5 text-[11px] text-muted-foreground">No pinned providers.</p>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </nav>

              <div class="shrink-0">
                <nav class="mt-4 space-y-1 border-t border-border/60 pt-4">
                  {supportNavigation().map((item) => (
                    <div class="space-y-1">
                      {item.children?.length ? (
                        <button
                          type="button"
                          aria-expanded={supportOpen(item)}
                          class={`group flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-all ${
                            supportActive(item) ? "text-foreground" : "text-muted-foreground hover:text-foreground/70"
                          }`}
                          onClick={() => toggleSupport(item)}
                        >
                          <UiIcon
                            name={item.icon}
                            class={`size-4 ${supportActive(item) ? "text-foreground" : "text-muted-foreground group-hover:text-foreground/70"}`}
                          />
                          <span class="min-w-0 flex-1 truncate">{item.name}</span>
                          <UiIcon
                            name="i-lucide-chevron-down"
                            class={`size-3.5 transition-transform ${supportOpen(item) ? "rotate-0" : "-rotate-90"}`}
                          />
                        </button>
                      ) : (
                        <A
                          href={item.href}
                          aria-disabled={item.disabled ? true : undefined}
                          class={`group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all ${
                            item.disabled
                              ? "cursor-default text-muted-foreground/45"
                              : isActive(item.href)
                                ? "text-foreground"
                                : "text-muted-foreground hover:text-foreground/70"
                          }`}
                          onClick={(event) => anchorNav.handleNavClick(item, event)}
                        >
                          <UiIcon
                            name={item.icon}
                            class={`size-4 ${
                              item.disabled
                                ? "text-muted-foreground/45"
                                : isActive(item.href)
                                  ? "text-foreground"
                                  : "text-muted-foreground group-hover:text-foreground/70"
                            }`}
                          />
                          {item.name}
                        </A>
                      )}
                    </div>
                  ))}
                </nav>
              </div>
            </div>
          </div>
        }
      />

      <UiDialog
        open={sharingDialog()}
        onOpenChange={setSharingDialog}
        ui={{ content: "sm:max-w-[400px]" }}
        content={
          <>
            <div class="space-y-1.5 pr-6">
              <h2 class="text-lg font-semibold leading-none tracking-tight">Stop Sharing</h2>
              <p class="text-sm text-muted-foreground">You won't earn points anymore?</p>
            </div>
            <div class="flex justify-end gap-2">
              <UiButton variant="outline" size="sm" onClick={() => setSharingDialog(false)}>
                Cancel
              </UiButton>
              <UiButton variant="destructive" size="sm" onClick={disableSharing}>
                Stop
              </UiButton>
            </div>
          </>
        }
      />

      <MaintainerAuditDialog open={auditDialogOpen()} onOpenChange={setAuditDialogOpen} onSelected={auditSelected} />
    </div>
  );
}

interface SubItemLinkProps {
  item: NavItem;
  subItem: NavSubItem;
  subActive: boolean;
  onNavClick: (item?: NavItem | NavSubItem, event?: MouseEvent) => void;
  countByHref: Record<string, number>;
  activeByHref: Record<string, number>;
  indicatorByHref: Record<string, ProviderAccountIndicator>;
  modelsFor: (subItem: NavSubItem) => number;
  sharingEnabled: boolean;
  toggleDisabled: boolean;
  toggleSharing: () => void;
}

function SubItemLink(props: SubItemLinkProps): JSX.Element {
  if (props.subItem.disabled) {
    return (
      <div class="flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground/60" aria-disabled="true">
        <span class="flex min-w-0 items-center gap-2">
          <span class="truncate">{props.subItem.name}</span>
          {props.subItem.tag && (
            <UiBadge variant="outline" class="border-border/40 bg-muted/20 px-1.5 py-0 text-[10px] lowercase text-muted-foreground/60">
              {props.subItem.tag}
            </UiBadge>
          )}
        </span>
      </div>
    );
  }

  if (isSwitch(props.subItem)) {
    return (
      <div class="flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground/70" onClick={props.toggleSharing}>
        <div class="flex min-w-0 items-center gap-1.5">
          <span class="min-w-0 truncate">{props.subItem.name}</span>
          <UiTooltip side="right" align="start" sideOffset={8} contentClass="w-64 p-3">
            <button
              type="button"
              aria-label="About sharing"
              class="hidden size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/60 outline-none transition-colors hover:text-foreground focus:outline-none focus-visible:outline-none focus-visible:ring-0 [@media(hover:hover)_and_(pointer:fine)]:inline-flex"
              onClick={(event) => event.stopPropagation()}
            >
              <UiIcon name="i-lucide-circle-question-mark" class="size-3 [stroke-width:1.5]" />
            </button>
          </UiTooltip>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={props.sharingEnabled}
          disabled={props.toggleDisabled}
          class="inline-flex shrink-0 cursor-pointer outline-none disabled:cursor-default"
          onClick={(event) => {
            event.stopPropagation();
            props.toggleSharing();
          }}
        >
          <span class="sr-only">{props.subItem.name}</span>
          <span
            aria-hidden="true"
            class={`inline-flex h-3.5 w-6 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all ${
              props.toggleDisabled ? "bg-muted opacity-60" : props.sharingEnabled ? "bg-primary" : "bg-input/80"
            }`}
          >
            <span
              class={`block size-3 rounded-full transition-transform ${
                props.sharingEnabled ? "translate-x-[calc(100%-2px)]" : "translate-x-0"
              } ${props.toggleDisabled ? "bg-muted-foreground/50" : props.sharingEnabled ? "bg-primary-foreground" : "bg-foreground"}`}
            />
          </span>
        </button>
      </div>
    );
  }

  return (
    <A
      href={hrefOf(props.subItem)}
      class={`flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
        props.subActive ? "text-foreground" : "text-muted-foreground hover:text-foreground/70"
      }`}
      onClick={(event) => props.onNavClick(props.subItem, event)}
    >
      <span class="flex min-w-0 items-center gap-2">
        <span class="truncate">{props.subItem.name}</span>
        {props.subItem.tag && (
          <UiBadge variant="outline" class="px-1.5 py-0 text-[10px] lowercase">
            {props.subItem.tag}
          </UiBadge>
        )}
      </span>
      {props.item.href === Routes.home ? (
        <AccountStatusIndicator
          accountCount={props.countByHref[props.subItem.href]}
          activeAccountCount={props.activeByHref[props.subItem.href]}
          indicator={props.indicatorByHref[props.subItem.href]}
        />
      ) : props.item.href === Routes.models && props.subItem.anchorId && props.modelsFor(props.subItem) > 0 ? (
        <span class={`px-1.5 py-0.5 text-[10px] font-semibold leading-none ${props.subActive ? "text-foreground" : "text-muted-foreground"}`}>
          {props.modelsFor(props.subItem)}
        </span>
      ) : null}
    </A>
  );
}
