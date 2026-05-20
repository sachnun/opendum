<script setup lang="ts">
import type {
  ModelFamilyCounts,
  NavItem,
  NavSubItem,
  ProviderAccountCounts,
  ProviderAccountIndicators,
} from "../../lib/navigation";
import type { AccountOverviewData, AccountOverviewDeltaData, AccountOverviewResponse, AccountPingData, PointStatusData } from "../../lib/dashboard-api-types";
import { MODEL_FAMILY_NAV_ITEMS, categorizeModelFamily } from "../../lib/model-families";
import { primaryNavigation } from "../../lib/navigation";
import { signOut, useSession } from "../../lib/auth-client";
import type { ProviderAccountKey } from "../../lib/provider-accounts";
import { buildProviderHrefMap, getProviderAccountPath, PROVIDER_ACCOUNT_DEFINITIONS } from "../../lib/provider-accounts";

const route = useRoute();
const { data: session } = await useSession(useFetch);

const mobileOpen = ref(false);
const userMenuOpen = ref(false);
const modelSearchFocused = ref(false);
const auditDialogOpen = ref(false);
const sharingEnabled = ref(false);
const sharingUpdating = ref(false);
const disableSharingDialogOpen = ref(false);
const supportItemOpen = reactive<Record<string, boolean>>({ Tools: false });
const mainContent = ref<HTMLElement | null>(null);
const activeAnchorId = ref<string | null>(null);
const mobileSidebarDragX = ref(0);
const isMobileSidebarDragging = ref(false);

const userLabel = computed(() => session.value?.user?.name || session.value?.user?.email || "Account");
const userEmail = computed(() => session.value?.user?.email || "");
const userImage = computed(() => session.value?.user?.image || "");
const userInitial = computed(() => (session.value?.user?.name?.[0] || "U").toUpperCase());

const emptyAccountCounts = Object.fromEntries(
  PROVIDER_ACCOUNT_DEFINITIONS.map((definition) => [definition.key, 0])
) as unknown as ProviderAccountCounts;

const emptyAccountIndicators = Object.fromEntries(
  PROVIDER_ACCOUNT_DEFINITIONS.map((definition) => [definition.key, "normal"])
) as unknown as ProviderAccountIndicators;

interface ShellAccountSummary {
  accountCounts: ProviderAccountCounts;
  activeAccountCounts: ProviderAccountCounts;
  accountIndicators: ProviderAccountIndicators;
  pinnedProviders: ProviderAccountKey[];
  hasConnectedAccounts: boolean;
}

const emptyShellAccountSummary: ShellAccountSummary = {
  accountCounts: { ...emptyAccountCounts },
  activeAccountCounts: { ...emptyAccountCounts },
  accountIndicators: { ...emptyAccountIndicators },
  pinnedProviders: [],
  hasConnectedAccounts: false,
};

const emptyModelFamilyCounts = Object.fromEntries(MODEL_FAMILY_NAV_ITEMS.map((family) => [family.anchorId, 0])) as ModelFamilyCounts;
const modelFamilyCountsOverride = useState<ModelFamilyCounts | null>("dashboard-model-family-counts-override", () => null);
const cachedPinnedProviders = useState<ProviderAccountKey[] | null>("dashboard-shell-pinned-providers", () => null);

const supportNavigation = computed<NavItem[]>(() => [
  {
    name: "Tools",
    href: "/dashboard/tools",
    icon: "i-lucide-wrench",
    children: [
      { name: "Email", href: "/dashboard/tools/email", disabled: true, tag: "soon" },
      { name: "OTP", href: "/dashboard/tools/otp", disabled: true, tag: "soon" },
    ],
  },
  { name: "Playground", href: "/dashboard/playground", icon: "i-lucide-flask-conical" },
]);
const PROVIDER_AVAILABILITY_ORDER = { active: 0, inactive: 1 } as const;
const PROVIDER_STATUS_ORDER = { error: 0, warning: 1, normal: 2 } as const;

const dashboardApi = useDashboardApi();
const dashboardInvalidation = useDashboardDataInvalidation();
const accountsNavigationHref = "/dashboard";
const { data: accountsOverviewData } = useNuxtData<AccountOverviewData>(dashboardInvalidation.keys.accountsOverview);

const { data: dashboardMe } = await useAsyncData("dashboard-me", () => dashboardApi.me.get(), {
  default: () => ({ role: "user" as const, isMaintener: false }),
});
const { auditUser, dashboardMe: dashboardMeState, isAuditMode, refreshAfterAuditChange } = useDashboardAudit();
dashboardMeState.value = dashboardMe.value ?? null;
watch(dashboardMe, (value) => {
  dashboardMeState.value = value ?? null;
}, { immediate: true });
const isMaintener = computed(() => dashboardMe.value?.isMaintener ?? false);
const pointBalance = computed(() => dashboardMe.value?.points?.balance ?? 0);
const formattedPointBalance = computed(() => pointBalance.value.toLocaleString("en-US"));
const auditUserLabel = computed(() => auditUser.value?.name || auditUser.value?.email || "Audit user");
const auditUserEmail = computed(() => auditUser.value?.email || "");
const auditUserImage = computed(() => auditUser.value?.image || "");
const auditUserInitial = computed(() => (auditUserLabel.value[0] || "U").toUpperCase());

watch(dashboardMe, (value) => {
  sharingEnabled.value = value?.sharing?.enabled ?? false;
}, { immediate: true });

function toShellAccountSummary(summary: AccountOverviewData | AccountPingData): ShellAccountSummary {
  const nextAccountCounts = { ...emptyAccountCounts };
  const nextActiveAccountCounts = { ...emptyAccountCounts };
  const nextAccountIndicators = { ...emptyAccountIndicators };
  let hasConnectedAccounts = "hasConnectedAccounts" in summary ? summary.hasConnectedAccounts : false;

  for (const definition of PROVIDER_ACCOUNT_DEFINITIONS) {
    const providerSummary = summary.summaries[definition.key];
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

function isAccountOverviewDelta(summary: AccountOverviewResponse): summary is AccountOverviewDeltaData {
  return "delta" in summary && summary.delta === true;
}

function applyAccountOverviewResponse(summary: AccountOverviewResponse): AccountOverviewData {
  if (!isAccountOverviewDelta(summary)) {
    accountsOverviewData.value = summary;
    return summary;
  }

  const current = accountsOverviewData.value;
  if (!current) {
    throw new Error("Cannot apply account overview delta without a snapshot");
  }

  const next: AccountOverviewData = {
    summaries: summary.summaries ? { ...current.summaries, ...summary.summaries } : current.summaries,
    pinnedProviders: summary.pinnedProviders ?? current.pinnedProviders,
    cursor: summary.cursor,
  };
  accountsOverviewData.value = next;
  return next;
}

const isProviderOverviewRoute = computed(() => route.path === accountsNavigationHref);

const { data: accountSummaryData, refresh: refreshAccountSummary } = await useAsyncData(dashboardInvalidation.keys.shellAccounts, async (): Promise<ShellAccountSummary> => {
  const useOverview = isProviderOverviewRoute.value;
  if (useOverview) {
    const cursor = accountsOverviewData.value?.cursor;
    const summary = applyAccountOverviewResponse(cursor ? await dashboardApi.accounts.overviewDelta({ cursor }) : await dashboardApi.accounts.overview());
    return toShellAccountSummary(summary);
  }

  return toShellAccountSummary(await dashboardApi.accounts.ping());
});

const accountCounts = computed(() => accountSummaryData.value?.accountCounts ?? emptyShellAccountSummary.accountCounts);
const activeAccountCounts = computed(() => accountSummaryData.value?.activeAccountCounts ?? emptyShellAccountSummary.activeAccountCounts);
const accountIndicators = computed(
  () => accountSummaryData.value?.accountIndicators ?? emptyShellAccountSummary.accountIndicators
);
const pinnedProviders = computed(() => accountSummaryData.value?.pinnedProviders ?? cachedPinnedProviders.value ?? emptyShellAccountSummary.pinnedProviders);
const hasLoadedAccountSummary = computed(() => Boolean(accountSummaryData.value));
const hasResolvedPinnedProviders = computed(() => hasLoadedAccountSummary.value || cachedPinnedProviders.value !== null);
const shouldRefreshAccountSummary = computed(() => true);

watch(accountSummaryData, (value) => {
  if (value) cachedPinnedProviders.value = value.pinnedProviders;
}, { immediate: true });

const activeAccountCountByHref = computed(() => buildProviderHrefMap(activeAccountCounts.value));
const accountCountByHref = computed(() => buildProviderHrefMap(accountCounts.value));
const accountIndicatorByHref = computed(() => buildProviderHrefMap(accountIndicators.value));
const accountNavigationHrefs = computed(() => new Set(PROVIDER_ACCOUNT_DEFINITIONS.map((definition) => getProviderAccountPath(definition.key))));

function normalizeModelFamilyCounts(counts: Record<string, number>) {
  const nextCounts = { ...emptyModelFamilyCounts };
  const anchorByFamily = new Map(MODEL_FAMILY_NAV_ITEMS.map((family) => [family.name, family.anchorId]));

  for (const [rawFamily, count] of Object.entries(counts)) {
    const family = categorizeModelFamily(rawFamily);
    const anchorId = anchorByFamily.get(family);
    if (anchorId) {
      nextCounts[anchorId] = (nextCounts[anchorId] ?? 0) + count;
    }
  }

  return nextCounts;
}

const { data: defaultModelFamilyCounts } = await useAsyncData("dashboard-shell-model-family-counts", async () => {
  const counts = await dashboardApi.models.familyCounts();
  return normalizeModelFamilyCounts(counts);
}, {
  default: () => ({ ...emptyModelFamilyCounts }),
});

const modelFamilyCounts = computed(() => modelFamilyCountsOverride.value ?? defaultModelFamilyCounts.value ?? emptyModelFamilyCounts);

const PENDING_NAV_ANCHOR_KEY = "opendum:pending-nav-anchor";
const HEADER_OFFSET = 112;
const PENDING_SCROLL_RETRIES = 20;
const PENDING_SCROLL_DELAY_MS = 60;
const ACCOUNT_SUMMARY_REFRESH_MS = 30_000;
const POINT_STATUS_REFRESH_MS = 15_000;
const MOBILE_SIDEBAR_SWIPE_CLOSE_THRESHOLD_PX = 96;
let accountSummaryRefreshTimer: ReturnType<typeof setInterval> | null = null;
let accountSummaryRefreshInFlight: Promise<void> | null = null;
let accountSummaryRefreshQueued = false;
let pointStatusRefreshTimer: ReturnType<typeof setInterval> | null = null;
let pointStatusRefreshInFlight: Promise<void> | null = null;
let pointStatusRefreshQueued = false;
let mobileSidebarSwipeStartX: number | null = null;
let mobileSidebarSwipePointerId: number | null = null;
let suppressNextMobileOverlayClick = false;
let mobileSidebarSwipeResetTimer: ReturnType<typeof setTimeout> | null = null;

const pinnedProviderHrefs = computed(() => {
  const hrefs = new Set<string>();

  pinnedProviders.value.forEach((key) => {
    const provider = PROVIDER_ACCOUNT_DEFINITIONS.find((definition) => definition.key === key);

    if (provider) {
      hrefs.add(getProviderAccountPath(provider.key));
    }
  });

  return hrefs;
});
const mobileSheetContentStyle = computed(() => {
  if (!mobileOpen.value) return undefined;

  const transform = mobileSidebarDragX.value === 0 ? undefined : `translateX(${mobileSidebarDragX.value}px)`;
  return {
    transform,
    transition: isMobileSidebarDragging.value ? "none" : undefined,
  };
});
const mobileSheetOverlayStyle = computed(() => {
  if (!mobileOpen.value || mobileSidebarDragX.value === 0) return undefined;

  return {
    opacity: Math.max(0.35, 1 - Math.abs(mobileSidebarDragX.value) / 320),
  };
});

function isActive(href: string) {
  if (href === accountsNavigationHref && accountNavigationHrefs.value.has(route.path)) return true;
  return route.path === href || (href !== "/dashboard" && route.path.startsWith(href));
}

function isAccountsNavItem(item: NavItem) {
  return item.href === accountsNavigationHref;
}

function isSupportItemActive(item: NavItem) {
  return isActive(item.href) || Boolean(item.children?.some((subItem) => isSubItemActive(subItem)));
}

function isSupportItemOpen(item: NavItem) {
  return !item.children?.length || supportItemOpen[item.name] !== false;
}

function toggleSupportItem(item: NavItem) {
  if (!item.children?.length) return;

  supportItemOpen[item.name] = !isSupportItemOpen(item);
}

function subItemHref(subItem: NavSubItem) {
  if (subItem.anchorId) {
    return `${subItem.href}#${subItem.anchorId}`;
  }

  return subItem.href;
}

function isSubItemActive(subItem: NavSubItem) {
  if (subItem.anchorId) {
    return route.path === subItem.href && (activeAnchorId.value ? activeAnchorId.value === subItem.anchorId : route.hash === `#${subItem.anchorId}`);
  }

  return route.path === subItem.href || route.path.startsWith(`${subItem.href}/`);
}

function visibleSubItems(item: NavItem) {
  if (!item.children) {
    return [];
  }

  if (isAccountsNavItem(item)) {
    return item.children
      .filter((subItem) => pinnedProviderHrefs.value.has(subItem.href))
      .sort((a, b) => {
        const availabilityA = (activeAccountCountByHref.value[a.href] ?? 0) > 0 ? "active" : "inactive";
        const availabilityB = (activeAccountCountByHref.value[b.href] ?? 0) > 0 ? "active" : "inactive";
        const indicatorA = accountIndicatorByHref.value[a.href] ?? "normal";
        const indicatorB = accountIndicatorByHref.value[b.href] ?? "normal";
        return PROVIDER_AVAILABILITY_ORDER[availabilityA] - PROVIDER_AVAILABILITY_ORDER[availabilityB]
          || PROVIDER_STATUS_ORDER[indicatorA] - PROVIDER_STATUS_ORDER[indicatorB]
          || a.name.localeCompare(b.name);
      });
  }

  if (item.href === "/dashboard/models") {
    return item.children.filter((subItem) => subItem.anchorId ? (modelFamilyCounts.value[subItem.anchorId] ?? 0) > 0 : true);
  }

  return item.children;
}

function modelCountFor(subItem: NavSubItem) {
  return subItem.anchorId ? (modelFamilyCounts.value[subItem.anchorId] ?? 0) : 0;
}

function isSwitchSubItem(subItem: NavSubItem) {
  return subItem.control === "switch";
}

function isSwitchSubItemToggleDisabled(subItem: NavSubItem) {
  return isSwitchSubItem(subItem) && (isAuditMode.value || sharingUpdating.value);
}

async function updateSharing(enabled: boolean) {
  if (isAuditMode.value || sharingUpdating.value) return;

  sharingUpdating.value = true;
  try {
    const result = await dashboardApi.sharing.update({ enabled });
    sharingEnabled.value = result.enabled;
    if (dashboardMe.value) {
      dashboardMe.value = {
        ...dashboardMe.value,
        sharing: { enabled: result.enabled },
      };
    }
  } finally {
    sharingUpdating.value = false;
  }
}

function toggleSharing() {
  if (isAuditMode.value || sharingUpdating.value) return;

  if (sharingEnabled.value) {
    disableSharingDialogOpen.value = true;
    return;
  }

  void updateSharing(true);
}

function disableSharing() {
  disableSharingDialogOpen.value = false;
  void updateSharing(false);
}

function cancelDisableSharing() {
  disableSharingDialogOpen.value = false;
}

const subNavigationAnchorIds = computed(() => primaryNavigation.flatMap((item) => visibleSubItems(item)
  .filter((subItem) => subItem.href === route.path && subItem.anchorId)
  .map((subItem) => subItem.anchorId as string)));

function setPendingAnchor(path: string, anchorId: string) {
  window.sessionStorage.setItem(PENDING_NAV_ANCHOR_KEY, JSON.stringify({ path, anchorId }));
}

function consumePendingAnchor(pathname: string) {
  const rawValue = window.sessionStorage.getItem(PENDING_NAV_ANCHOR_KEY);
  if (!rawValue) return null;

  try {
    const pendingAnchor = JSON.parse(rawValue) as { path?: string; anchorId?: string };
    if (pendingAnchor.path !== pathname || !pendingAnchor.anchorId) return null;

    window.sessionStorage.removeItem(PENDING_NAV_ANCHOR_KEY);
    return pendingAnchor.anchorId;
  } catch {
    window.sessionStorage.removeItem(PENDING_NAV_ANCHOR_KEY);
    return null;
  }
}

function scrollToAnchor(anchorId: string) {
  const section = document.getElementById(anchorId);
  if (!section) return false;

  section.scrollIntoView({ behavior: "smooth", block: "start" });
  activeAnchorId.value = anchorId;
  return true;
}

function getAnchorIdFromViewport(anchorIds: string[]) {
  let firstAvailableAnchorId: string | null = null;
  let lastPassedAnchorId: string | null = null;

  for (const anchorId of anchorIds) {
    const section = document.getElementById(anchorId);
    if (!section) continue;

    firstAvailableAnchorId ??= anchorId;

    if (section.getBoundingClientRect().top <= HEADER_OFFSET) {
      lastPassedAnchorId = anchorId;
    }
  }

  return lastPassedAnchorId ?? firstAvailableAnchorId;
}

function handleNavClick(item?: NavItem | NavSubItem, event?: MouseEvent) {
  if (item?.disabled) {
    event?.preventDefault();
    return;
  }

  if (item && "anchorId" in item && item.anchorId) {
    if (route.path === item.href) {
      event?.preventDefault();
      scrollToAnchor(item.anchorId);
    } else if (import.meta.client) {
      setPendingAnchor(item.href, item.anchorId);
    }
  }

  mobileOpen.value = false;
}

function resetMobileSidebarSwipe() {
  if (mobileSidebarSwipeResetTimer) {
    clearTimeout(mobileSidebarSwipeResetTimer);
    mobileSidebarSwipeResetTimer = null;
  }

  mobileSidebarSwipeStartX = null;
  mobileSidebarSwipePointerId = null;
  isMobileSidebarDragging.value = false;
  mobileSidebarDragX.value = 0;
}

function closeMobileSidebar({ keepDragOffset = false } = {}) {
  mobileOpen.value = false;

  if (keepDragOffset) {
    mobileSidebarSwipeStartX = null;
    mobileSidebarSwipePointerId = null;
    isMobileSidebarDragging.value = false;
    mobileSidebarSwipeResetTimer = setTimeout(resetMobileSidebarSwipe, 350);
    return;
  }

  resetMobileSidebarSwipe();
}

function handleMobileOverlayClick(event: MouseEvent) {
  if (suppressNextMobileOverlayClick) {
    suppressNextMobileOverlayClick = false;
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  if (isMobileSidebarDragging.value || mobileSidebarDragX.value !== 0) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  closeMobileSidebar();
}

function handleMobileSheetPointerDownOutside(event: Event) {
  if (mobileSidebarSwipeStartX === null) return;
  event.preventDefault();
}

function handleMobileOverlayPointerDown(event: PointerEvent) {
  if (!mobileOpen.value) return;
  if (event.pointerType === "mouse" && event.button !== 0) return;

  mobileSidebarSwipeStartX = event.clientX;
  mobileSidebarSwipePointerId = event.pointerId;
  isMobileSidebarDragging.value = false;
  mobileSidebarDragX.value = 0;
}

function handleMobileOverlayPointerMove(event: PointerEvent) {
  if (mobileSidebarSwipeStartX === null || mobileSidebarSwipePointerId !== event.pointerId) return;

  const deltaX = event.clientX - mobileSidebarSwipeStartX;
  if (deltaX >= 0) {
    if (isMobileSidebarDragging.value) event.preventDefault();
    mobileSidebarDragX.value = 0;
    return;
  }

  isMobileSidebarDragging.value = true;
  mobileSidebarDragX.value = deltaX;
  event.preventDefault();
}

function finishMobileOverlaySwipe(event?: PointerEvent) {
  if (event && mobileSidebarSwipePointerId !== event.pointerId) return;

  const wasDragging = isMobileSidebarDragging.value;
  const shouldClose = Math.abs(mobileSidebarDragX.value) >= MOBILE_SIDEBAR_SWIPE_CLOSE_THRESHOLD_PX;
  if (shouldClose) {
    closeMobileSidebar({ keepDragOffset: true });
    return;
  }

  resetMobileSidebarSwipe();
  suppressNextMobileOverlayClick = wasDragging;
}

async function refreshAccountSummaryOnce() {
  if (!shouldRefreshAccountSummary.value) return;

  if (accountSummaryRefreshInFlight) {
    accountSummaryRefreshQueued = true;
    return;
  }

  accountSummaryRefreshInFlight = refreshAccountSummary().then(() => undefined);
  try {
    await accountSummaryRefreshInFlight;
  } finally {
    accountSummaryRefreshInFlight = null;
    const shouldRefreshAgain = accountSummaryRefreshQueued && shouldRefreshAccountSummary.value;
    accountSummaryRefreshQueued = false;

    if (shouldRefreshAgain) {
      void refreshAccountSummaryOnce();
    }
  }
}

function stopAccountSummaryRefresh() {
  accountSummaryRefreshQueued = false;
  if (!accountSummaryRefreshTimer) return;

  clearInterval(accountSummaryRefreshTimer);
  accountSummaryRefreshTimer = null;
}

function startAccountSummaryRefresh() {
  if (accountSummaryRefreshTimer || !shouldRefreshAccountSummary.value) return;

  accountSummaryRefreshTimer = setInterval(() => {
    void refreshAccountSummaryOnce();
  }, ACCOUNT_SUMMARY_REFRESH_MS);
}

function applyPointStatus(status: PointStatusData) {
  if (dashboardMe.value) {
    dashboardMe.value = {
      ...dashboardMe.value,
      points: { balance: status.balance },
    };
  }

  dashboardInvalidation.patchApiKeyRoamingPoints(status.roamingPointsByApiKeyId);
}

async function refreshPointStatusOnce() {
  if (pointStatusRefreshInFlight) {
    pointStatusRefreshQueued = true;
    return;
  }

  pointStatusRefreshInFlight = dashboardApi.points.status().then(applyPointStatus);
  try {
    await pointStatusRefreshInFlight;
  } catch (error) {
    console.error("Failed to refresh points:", error);
  } finally {
    pointStatusRefreshInFlight = null;
    const shouldRefreshAgain = pointStatusRefreshQueued;
    pointStatusRefreshQueued = false;

    if (shouldRefreshAgain) {
      void refreshPointStatusOnce();
    }
  }
}

function stopPointStatusRefresh() {
  pointStatusRefreshQueued = false;
  if (!pointStatusRefreshTimer) return;

  clearInterval(pointStatusRefreshTimer);
  pointStatusRefreshTimer = null;
}

function startPointStatusRefresh() {
  if (pointStatusRefreshTimer) return;

  void refreshPointStatusOnce();
  pointStatusRefreshTimer = setInterval(() => {
    void refreshPointStatusOnce();
  }, POINT_STATUS_REFRESH_MS);
}

onMounted(() => {
  startPointStatusRefresh();

  watch(shouldRefreshAccountSummary, (shouldRefresh) => {
    if (shouldRefresh) {
      startAccountSummaryRefresh();
      return;
    }

    stopAccountSummaryRefresh();
  }, { immediate: true });

  watch(subNavigationAnchorIds, (anchorIds, _previousAnchorIds, onCleanup) => {
    if (anchorIds.length === 0) {
      activeAnchorId.value = null;
      return;
    }

    let rafId: number | null = null;
    const scrollTarget = mainContent.value;

    const syncActiveAnchor = () => {
      activeAnchorId.value = getAnchorIdFromViewport(anchorIds);
    };

    const scheduleSync = () => {
      if (rafId !== null) return;

      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        syncActiveAnchor();
      });
    };

    const observer = new IntersectionObserver(() => {
      scheduleSync();
    }, {
      root: null,
      rootMargin: `-${HEADER_OFFSET}px 0px -55% 0px`,
      threshold: [0, 0.25, 0.5, 0.75, 1],
    });

    for (const anchorId of anchorIds) {
      const section = document.getElementById(anchorId);
      if (section) observer.observe(section);
    }

    scheduleSync();
    window.addEventListener("scroll", scheduleSync, { passive: true });
    window.addEventListener("resize", scheduleSync);
    scrollTarget?.addEventListener("scroll", scheduleSync, { passive: true });

    onCleanup(() => {
      observer.disconnect();
      window.removeEventListener("scroll", scheduleSync);
      window.removeEventListener("resize", scheduleSync);
      scrollTarget?.removeEventListener("scroll", scheduleSync);
      if (rafId !== null) window.cancelAnimationFrame(rafId);
    });
  }, { immediate: true });

  watch(() => route.path, () => {
    const pendingAnchorId = consumePendingAnchor(route.path);
    if (!pendingAnchorId) return;

    let retriesLeft = PENDING_SCROLL_RETRIES;

    const tryScroll = () => {
      if (scrollToAnchor(pendingAnchorId)) return;

      retriesLeft -= 1;
      if (retriesLeft <= 0) return;

      window.setTimeout(tryScroll, PENDING_SCROLL_DELAY_MS);
    };

    tryScroll();
  }, { immediate: true });
});

onBeforeUnmount(() => {
  stopAccountSummaryRefresh();
  stopPointStatusRefresh();
  resetMobileSidebarSwipe();
});

async function handleSignOut() {
  if (isAuditMode.value) {
    await dashboardApi.maintener.audit.stop();
    userMenuOpen.value = false;
    await refreshAfterAuditChange();
    return;
  }

  await signOut();
  await navigateTo("/");
}

function openAuditDialog() {
  userMenuOpen.value = false;
  auditDialogOpen.value = true;
}

async function handleAuditSelected() {
  await refreshAfterAuditChange();
}
</script>

<template>
  <div class="min-h-svh bg-background text-foreground">
    <div class="dashboard-layout-frame relative mx-auto flex min-h-svh w-full md:max-w-screen-md lg:max-w-screen-lg xl:max-w-screen-xl 2xl:max-w-screen-2xl min-[1920px]:max-w-[120rem]">
    <aside class="sticky top-0 hidden border-r border-border bg-background md:flex md:h-svh md:w-60 md:shrink-0 md:flex-col">
      <div class="flex h-16 items-center border-b border-border px-5">
        <NuxtLink to="/dashboard" class="inline-flex items-center gap-2.5">
          <span class="relative flex h-2.5 w-2.5">
            <span class="absolute inset-0 inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
            <span class="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
          </span>
          <span class="inline-flex items-center gap-2 text-base font-semibold tracking-tight">
            Opendum
            <span v-if="isMaintener" class="rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none text-muted-foreground">
              dev
            </span>
          </span>
        </NuxtLink>
      </div>

      <div class="flex min-h-0 flex-1 flex-col px-3 py-4">
        <nav class="scrollbar-none min-h-0 flex-1 overflow-y-auto pr-1">
          <div class="space-y-1">
            <div v-for="item in primaryNavigation" :key="item.name" class="space-y-1">
              <NuxtLink
                :to="item.href"
                :class="[
                  'group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all',
                  isActive(item.href) ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                ]"
                @click="handleNavClick(item, $event)"
              >
                <UiIcon :name="item.icon" :class="['size-4', isActive(item.href) ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground']" />
                {{ item.name }}
              </NuxtLink>

              <div v-if="item.children?.length" class="ml-6 space-y-1 border-l border-border/60 pl-3">
                <template v-if="visibleSubItems(item).length">
                  <template v-for="subItem in visibleSubItems(item)" :key="`${item.name}-${subItem.name}`">
                    <div
                      v-if="subItem.disabled"
                      class="flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground/60"
                      aria-disabled="true"
                    >
                      <span class="flex min-w-0 items-center gap-2">
                        <span class="truncate">{{ subItem.name }}</span>
                        <UiBadge v-if="subItem.tag" variant="outline" class="border-border/40 bg-muted/20 px-1.5 py-0 text-[10px] lowercase text-muted-foreground/60">
                          {{ subItem.tag }}
                        </UiBadge>
                      </span>
                    </div>
                    <div
                      v-else-if="isSwitchSubItem(subItem)"
                      :class="[
                        'flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs font-medium outline-none transition-colors',
                        'cursor-pointer text-muted-foreground hover:bg-accent hover:text-foreground',
                      ]"
                      @click="toggleSharing"
                    >
                      <div class="flex min-w-0 items-center gap-1.5">
                        <span class="min-w-0 truncate">{{ subItem.name }}</span>
                        <UiTooltip side="right" align="start" :side-offset="8" content-class="w-64 p-3">
                          <button
                            type="button"
                            aria-label="About sharing"
                            class="hidden size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/60 outline-none transition-colors hover:text-foreground focus:outline-none focus-visible:outline-none focus-visible:ring-0 [@media(hover:hover)_and_(pointer:fine)]:inline-flex"
                            @click.stop
                          >
                            <UiIcon name="i-lucide-circle-question-mark" class="size-3 [stroke-width:1.5]" />
                          </button>
                          <template #content>
                            <div class="space-y-1 text-xs leading-relaxed">
                              <p class="font-medium text-foreground">Sharing</p>
                              <p class="text-muted-foreground">Enable sharing to let other users use your available provider accounts through roaming API keys. You earn points only when their requests succeed.</p>
                            </div>
                          </template>
                        </UiTooltip>
                        <UiPopover :content="{ align: 'start', side: 'right', sideOffset: 8, class: 'w-64 p-3' }">
                          <button
                            type="button"
                            aria-label="About sharing"
                            class="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/60 outline-none transition-colors hover:text-foreground focus:outline-none focus-visible:outline-none focus-visible:ring-0 [@media(hover:hover)_and_(pointer:fine)]:hidden"
                            @click.stop
                          >
                            <UiIcon name="i-lucide-circle-question-mark" class="size-3 [stroke-width:1.5]" />
                          </button>
                          <template #content>
                            <div class="space-y-1 text-xs leading-relaxed">
                              <p class="font-medium text-foreground">Sharing</p>
                              <p class="text-muted-foreground">Enable sharing to let other users use your available provider accounts through roaming API keys. You earn points only when their requests succeed.</p>
                            </div>
                          </template>
                        </UiPopover>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        :aria-checked="sharingEnabled"
                        :aria-disabled="isSwitchSubItemToggleDisabled(subItem) ? true : undefined"
                        :disabled="isSwitchSubItemToggleDisabled(subItem)"
                        class="inline-flex shrink-0 cursor-pointer outline-none disabled:cursor-default"
                        @click.stop="toggleSharing"
                      >
                        <span
                          aria-hidden="true"
                          :class="[
                            'inline-flex h-3.5 w-6 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all',
                            isSwitchSubItemToggleDisabled(subItem) ? 'bg-muted opacity-60' : sharingEnabled ? 'bg-primary' : 'bg-input/80',
                          ]"
                        >
                          <span
                            :class="[
                              'block size-3 rounded-full transition-transform',
                              sharingEnabled ? 'translate-x-[calc(100%-2px)]' : 'translate-x-0',
                              isSwitchSubItemToggleDisabled(subItem) ? 'bg-muted-foreground/50' : sharingEnabled ? 'bg-primary-foreground' : 'bg-foreground',
                            ]"
                          />
                        </span>
                      </button>
                    </div>
                    <NuxtLink
                      v-else
                      :to="subItemHref(subItem)"
                      :class="[
                        'flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                        isSubItemActive(subItem) ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                      ]"
                      @click="handleNavClick(subItem, $event)"
                    >
                      <span class="flex min-w-0 items-center gap-2">
                        <span class="truncate">{{ subItem.name }}</span>
                        <UiBadge v-if="subItem.tag" variant="outline" class="px-1.5 py-0 text-[10px] lowercase">
                          {{ subItem.tag }}
                        </UiBadge>
                      </span>
                      <span v-if="isAccountsNavItem(item)" class="flex items-center gap-2">
                        <AccountStatusIndicator
                          :account-count="accountCountByHref[subItem.href]"
                          :active-account-count="activeAccountCountByHref[subItem.href]"
                          :indicator="accountIndicatorByHref[subItem.href]"
                        />
                      </span>
                      <span
                        v-else-if="item.href === '/dashboard/models' && subItem.anchorId && modelCountFor(subItem) > 0"
                        :class="[
                          'px-1.5 py-0.5 text-[10px] font-semibold leading-none',
                          isSubItemActive(subItem) ? 'text-foreground' : 'text-muted-foreground',
                        ]"
                      >
                        {{ modelCountFor(subItem) }}
                      </span>
                    </NuxtLink>
                  </template>
                </template>
                <p
                  v-else-if="isAccountsNavItem(item)"
                  :class="[
                    'min-h-6 px-2.5 py-1.5 text-[11px] text-muted-foreground transition-opacity',
                    hasResolvedPinnedProviders ? 'opacity-100' : 'opacity-0',
                  ]"
                  :aria-hidden="!hasResolvedPinnedProviders"
                >
                  No pinned providers.
                </p>
              </div>
            </div>
          </div>
        </nav>

        <div class="shrink-0">
          <nav class="mt-4 space-y-1 border-t border-border/60 pt-4">
            <div v-for="item in supportNavigation" :key="item.name" class="space-y-1">
              <button
                v-if="item.children?.length"
                type="button"
                :aria-expanded="isSupportItemOpen(item)"
                :class="[
                  'group flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-all',
                  isSupportItemActive(item) ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                ]"
                @click="toggleSupportItem(item)"
              >
                <UiIcon :name="item.icon" :class="['size-4', isSupportItemActive(item) ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground']" />
                <span class="min-w-0 flex-1 truncate">{{ item.name }}</span>
                <UiIcon name="i-lucide-chevron-down" :class="['size-3.5 transition-transform', isSupportItemOpen(item) ? 'rotate-0' : '-rotate-90']" />
              </button>
              <NuxtLink
                v-else
                :to="item.href"
                :aria-disabled="item.disabled ? true : undefined"
                :class="[
                  'group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all',
                  item.disabled ? 'cursor-default text-muted-foreground/45' : isActive(item.href) ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                ]"
                @click="handleNavClick(item, $event)"
              >
                <UiIcon :name="item.icon" :class="['size-4', item.disabled ? 'text-muted-foreground/45' : isActive(item.href) ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground']" />
                {{ item.name }}
              </NuxtLink>

              <div v-if="item.children?.length && isSupportItemOpen(item)" class="ml-6 space-y-1 border-l border-border/60 pl-3">
                <template v-for="subItem in item.children" :key="`${item.name}-${subItem.name}`">
                  <div
                    v-if="subItem.disabled"
                    class="flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground/50"
                    aria-disabled="true"
                  >
                    <span class="flex min-w-0 items-center gap-2">
                      <span class="truncate">{{ subItem.name }}</span>
                      <UiBadge v-if="subItem.tag" variant="outline" class="border-border/40 bg-muted/20 px-1.5 py-0 text-[10px] lowercase text-muted-foreground/60">
                        {{ subItem.tag }}
                      </UiBadge>
                    </span>
                  </div>
                  <NuxtLink
                    v-else
                    :to="subItemHref(subItem)"
                    :class="[
                      'flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                      isSubItemActive(subItem) ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    ]"
                    @click="handleNavClick(subItem, $event)"
                  >
                    <span class="flex min-w-0 items-center gap-2">
                      <span class="truncate">{{ subItem.name }}</span>
                      <UiBadge v-if="subItem.tag" variant="outline" class="px-1.5 py-0 text-[10px] lowercase">
                        {{ subItem.tag }}
                      </UiBadge>
                    </span>
                  </NuxtLink>
                </template>
              </div>
            </div>
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
              @click="mobileOpen = true"
            >
              <UiIcon name="i-lucide-menu" class="size-8" />
              <span class="sr-only">Toggle menu</span>
            </button>
          </div>

          <div class="min-w-0 flex-1">
            <ModelSearchPopover @focus-change="modelSearchFocused = $event" />
          </div>

          <div class="flex items-center gap-1.5 sm:gap-2">
            <UiPopover v-model:open="userMenuOpen" :content="{ align: 'end', sideOffset: 8, arrowClass: 'translate-x-5' }">
              <button
                type="button"
                aria-label="Open account menu"
                class="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-full px-1 transition-opacity hover:opacity-80"
              >
                <PointCoinIcon
                  :class="[
                    'size-6 shrink-0 text-foreground/85 drop-shadow-[0_0_0.35rem_rgba(255,255,255,0.18)]',
                    modelSearchFocused ? 'hidden sm:block' : '',
                  ]"
                />
                <span :class="['select-none text-sm font-semibold tabular-nums text-foreground/85', modelSearchFocused ? 'hidden sm:inline' : '']">{{ formattedPointBalance }}</span>
                <span class="relative flex size-8 shrink-0 select-none sm:ml-1">
                  <span class="flex size-8 overflow-hidden rounded-full">
                    <img v-if="userImage" :src="userImage" alt="" class="aspect-square size-full">
                    <span v-else class="flex size-full items-center justify-center rounded-full bg-muted text-sm text-muted-foreground">
                      {{ userInitial }}
                    </span>
                  </span>
                  <span v-if="isAuditMode" class="absolute -bottom-1 -left-1 flex size-5 overflow-hidden rounded-full border-2 border-background bg-muted ring-1 ring-border">
                    <img v-if="auditUserImage" :src="auditUserImage" alt="" class="aspect-square size-full">
                    <span v-else class="flex size-full items-center justify-center text-[9px] font-semibold text-muted-foreground">
                      {{ auditUserInitial }}
                    </span>
                  </span>
                </span>
              </button>

              <template #content>
                <div class="w-64 max-w-[calc(100vw-2rem)] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
                  <div class="px-2 py-1.5 text-sm font-medium">
                    <div class="flex flex-col">
                      <span class="truncate">{{ userLabel }}</span>
                      <span class="truncate text-xs text-muted-foreground">{{ userEmail }}</span>
                    </div>
                  </div>
                  <div v-if="isAuditMode" class="mx-1 mt-1 mb-2 rounded-md border border-border/70 bg-muted/30 px-2 py-2 text-sm">
                    <div class="space-y-0.5">
                      <div class="flex items-center justify-between gap-2">
                        <p class="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Auditing</p>
                        <UiTooltip text="Change" side="left" align="center">
                          <button
                            type="button"
                            aria-label="Change"
                            class="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border/70 bg-background/80 text-muted-foreground shadow-xs outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                            @click="openAuditDialog"
                          >
                            <UiIcon name="i-lucide-refresh-cw" class="size-3.5" />
                          </button>
                        </UiTooltip>
                      </div>
                      <div class="min-w-0">
                        <p class="truncate font-medium">{{ auditUserLabel }}</p>
                        <p class="truncate text-xs text-muted-foreground">{{ auditUserEmail }}</p>
                      </div>
                    </div>
                  </div>
                  <div class="-mx-1 my-2 h-px bg-border" />
                  <div class="space-y-1">
                    <div class="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-left text-sm font-medium text-foreground">
                      <span>Point</span>
                    </div>
                    <div class="ml-3 space-y-1 border-l border-border/60 pl-3">
                      <div
                        class="flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground/50"
                        aria-disabled="true"
                      >
                        <span class="flex min-w-0 items-center gap-2">
                          <span class="truncate">Topup</span>
                          <UiBadge variant="outline" class="border-border/40 bg-muted/20 px-1.5 py-0 text-[10px] lowercase text-muted-foreground/60">
                            soon
                          </UiBadge>
                        </span>
                      </div>
                      <div
                        class="flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground/50"
                        aria-disabled="true"
                      >
                        <span class="flex min-w-0 items-center gap-2">
                          <span class="truncate">Withdraw</span>
                          <UiBadge variant="outline" class="border-border/40 bg-muted/20 px-1.5 py-0 text-[10px] lowercase text-muted-foreground/60">
                            soon
                          </UiBadge>
                        </span>
                      </div>
                    </div>
                  </div>
                  <button
                    v-if="isMaintener && !isAuditMode"
                    type="button"
                    class="relative flex w-full cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
                    @click="openAuditDialog"
                  >
                    Auditing
                  </button>
                  <button
                    type="button"
                    class="relative flex w-full cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
                    @click="handleSignOut"
                  >
                    Sign out
                  </button>
                </div>
              </template>
            </UiPopover>
          </div>
        </div>
      </header>

      <main ref="mainContent" class="flex-1">
        <div class="w-full px-5 pb-8 pt-5 sm:px-6 lg:px-8">
          <slot />
        </div>
      </main>
    </div>

    </div>

    <UiSheet
      v-model:open="mobileOpen"
      side="left"
      :ui="{ overlay: 'touch-none', content: 'w-[78vw] max-w-[18rem] p-0' }"
      :overlay-style="mobileSheetOverlayStyle"
      :content-style="mobileSheetContentStyle"
      @overlay-click="handleMobileOverlayClick"
      @overlay-pointer-down="handleMobileOverlayPointerDown"
      @overlay-pointer-move="handleMobileOverlayPointerMove"
      @overlay-pointer-up="finishMobileOverlaySwipe"
      @overlay-pointer-cancel="finishMobileOverlaySwipe"
      @content-pointer-down-outside="handleMobileSheetPointerDownOutside"
    >
      <template #content>
        <div class="flex h-full flex-col bg-background">
          <div class="flex h-16 items-center justify-between border-b border-border px-5">
            <NuxtLink to="/dashboard" class="inline-flex items-center gap-2 text-base font-semibold tracking-tight" @click="mobileOpen = false">
              <span class="relative flex h-2.5 w-2.5">
                <span class="absolute inset-0 inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                <span class="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
              </span>
              <span class="inline-flex items-center gap-2">
                Opendum
                <span v-if="isMaintener" class="rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none text-muted-foreground">
                  dev
                </span>
              </span>
            </NuxtLink>
            <button type="button" class="cursor-pointer opacity-70 transition-opacity hover:opacity-100 focus:outline-none" @click="mobileOpen = false">
              <UiIcon name="i-lucide-x" class="size-4" />
              <span class="sr-only">Close</span>
            </button>
          </div>

          <div class="flex min-h-0 flex-1 flex-col px-3 py-4">
            <nav class="scrollbar-none min-h-0 flex-1 overflow-y-auto pr-1">
              <div class="space-y-1">
                <div v-for="item in primaryNavigation" :key="`mobile-${item.name}`" class="space-y-1">
                  <NuxtLink
                    :to="item.href"
                    :class="[
                      'group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all',
                      isActive(item.href) ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    ]"
                    @click="handleNavClick(item, $event)"
                  >
                    <UiIcon :name="item.icon" :class="['size-4', isActive(item.href) ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground']" />
                    {{ item.name }}
                  </NuxtLink>

                  <div v-if="item.children?.length" class="ml-6 space-y-1 border-l border-border/60 pl-3">
                    <template v-if="visibleSubItems(item).length">
                      <template v-for="subItem in visibleSubItems(item)" :key="`mobile-${item.name}-${subItem.name}`">
                        <div
                          v-if="subItem.disabled"
                          class="flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground/60"
                          aria-disabled="true"
                        >
                          <span class="flex min-w-0 items-center gap-2">
                            <span class="truncate">{{ subItem.name }}</span>
                            <UiBadge v-if="subItem.tag" variant="outline" class="border-border/40 bg-muted/20 px-1.5 py-0 text-[10px] lowercase text-muted-foreground/60">
                              {{ subItem.tag }}
                            </UiBadge>
                          </span>
                        </div>
                        <div
                          v-else-if="isSwitchSubItem(subItem)"
                          :class="[
                            'flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs font-medium outline-none transition-colors',
                            'cursor-pointer text-muted-foreground hover:bg-accent hover:text-foreground',
                          ]"
                          @click="toggleSharing"
                        >
                          <div class="flex min-w-0 items-center gap-1.5">
                            <span class="min-w-0 truncate">{{ subItem.name }}</span>
                            <UiTooltip side="right" align="start" :side-offset="8" content-class="w-64 p-3">
                              <button
                                type="button"
                                aria-label="About sharing"
                                class="hidden size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/60 outline-none transition-colors hover:text-foreground focus:outline-none focus-visible:outline-none focus-visible:ring-0 [@media(hover:hover)_and_(pointer:fine)]:inline-flex"
                                @click.stop
                              >
                                <UiIcon name="i-lucide-circle-question-mark" class="size-3 [stroke-width:1.5]" />
                              </button>
                              <template #content>
                                <div class="space-y-1 text-xs leading-relaxed">
                                  <p class="font-medium text-foreground">Sharing</p>
                                  <p class="text-muted-foreground">Enable sharing to let other users use your available provider accounts through roaming API keys. You earn points only when their requests succeed.</p>
                                </div>
                              </template>
                            </UiTooltip>
                            <UiPopover :content="{ align: 'start', side: 'right', sideOffset: 8, class: 'w-64 p-3' }">
                              <button
                                type="button"
                                aria-label="About sharing"
                                class="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/60 outline-none transition-colors hover:text-foreground focus:outline-none focus-visible:outline-none focus-visible:ring-0 [@media(hover:hover)_and_(pointer:fine)]:hidden"
                                @click.stop
                              >
                                <UiIcon name="i-lucide-circle-question-mark" class="size-3 [stroke-width:1.5]" />
                              </button>
                              <template #content>
                                <div class="space-y-1 text-xs leading-relaxed">
                                  <p class="font-medium text-foreground">Sharing</p>
                                  <p class="text-muted-foreground">Enable sharing to let other users use your available provider accounts through roaming API keys. You earn points only when their requests succeed.</p>
                                </div>
                              </template>
                            </UiPopover>
                          </div>
                          <button
                            type="button"
                            role="switch"
                            :aria-checked="sharingEnabled"
                            :aria-disabled="isSwitchSubItemToggleDisabled(subItem) ? true : undefined"
                            :disabled="isSwitchSubItemToggleDisabled(subItem)"
                            class="inline-flex shrink-0 cursor-pointer outline-none disabled:cursor-default"
                            @click.stop="toggleSharing"
                          >
                            <span
                              aria-hidden="true"
                              :class="[
                                'inline-flex h-3.5 w-6 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all',
                                isSwitchSubItemToggleDisabled(subItem) ? 'bg-muted opacity-60' : sharingEnabled ? 'bg-primary' : 'bg-input/80',
                              ]"
                            >
                              <span
                                :class="[
                                  'block size-3 rounded-full transition-transform',
                                  sharingEnabled ? 'translate-x-[calc(100%-2px)]' : 'translate-x-0',
                                  isSwitchSubItemToggleDisabled(subItem) ? 'bg-muted-foreground/50' : sharingEnabled ? 'bg-primary-foreground' : 'bg-foreground',
                                ]"
                              />
                            </span>
                          </button>
                        </div>
                        <NuxtLink
                          v-else
                          :to="subItemHref(subItem)"
                          :class="[
                            'flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                            isSubItemActive(subItem) ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                          ]"
                          @click="handleNavClick(subItem, $event)"
                        >
                          <span class="flex min-w-0 items-center gap-2">
                            <span class="truncate">{{ subItem.name }}</span>
                            <UiBadge v-if="subItem.tag" variant="outline" class="px-1.5 py-0 text-[10px] lowercase">
                              {{ subItem.tag }}
                            </UiBadge>
                          </span>
                          <AccountStatusIndicator
                            v-if="isAccountsNavItem(item)"
                            :account-count="accountCountByHref[subItem.href]"
                            :active-account-count="activeAccountCountByHref[subItem.href]"
                            :indicator="accountIndicatorByHref[subItem.href]"
                          />
                          <span
                            v-else-if="item.href === '/dashboard/models' && subItem.anchorId && modelCountFor(subItem) > 0"
                            :class="[
                              'px-1.5 py-0.5 text-[10px] font-semibold leading-none',
                              isSubItemActive(subItem) ? 'text-foreground' : 'text-muted-foreground',
                            ]"
                          >
                            {{ modelCountFor(subItem) }}
                          </span>
                        </NuxtLink>
                      </template>
                    </template>
                    <p
                      v-else-if="isAccountsNavItem(item)"
                      :class="[
                        'min-h-6 px-2.5 py-1.5 text-[11px] text-muted-foreground transition-opacity',
                        hasResolvedPinnedProviders ? 'opacity-100' : 'opacity-0',
                      ]"
                      :aria-hidden="!hasResolvedPinnedProviders"
                    >
                      No pinned providers.
                    </p>
                  </div>
                </div>
              </div>
            </nav>

            <div class="shrink-0">
              <nav class="mt-4 space-y-1 border-t border-border/60 pt-4">
                <div v-for="item in supportNavigation" :key="`mobile-${item.name}`" class="space-y-1">
                  <button
                    v-if="item.children?.length"
                    type="button"
                    :aria-expanded="isSupportItemOpen(item)"
                    :class="[
                      'group flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-all',
                      isSupportItemActive(item) ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    ]"
                    @click="toggleSupportItem(item)"
                  >
                    <UiIcon :name="item.icon" :class="['size-4', isSupportItemActive(item) ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground']" />
                    <span class="min-w-0 flex-1 truncate">{{ item.name }}</span>
                    <UiIcon name="i-lucide-chevron-down" :class="['size-3.5 transition-transform', isSupportItemOpen(item) ? 'rotate-0' : '-rotate-90']" />
                  </button>
                  <NuxtLink
                    v-else
                    :to="item.href"
                    :aria-disabled="item.disabled ? true : undefined"
                    :class="[
                      'group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all',
                      item.disabled ? 'cursor-default text-muted-foreground/45' : isActive(item.href) ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    ]"
                    @click="handleNavClick(item, $event)"
                  >
                    <UiIcon :name="item.icon" :class="['size-4', item.disabled ? 'text-muted-foreground/45' : isActive(item.href) ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground']" />
                    {{ item.name }}
                  </NuxtLink>

                  <div v-if="item.children?.length && isSupportItemOpen(item)" class="ml-6 space-y-1 border-l border-border/60 pl-3">
                    <template v-for="subItem in item.children" :key="`mobile-${item.name}-${subItem.name}`">
                      <div
                        v-if="subItem.disabled"
                        class="flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground/50"
                        aria-disabled="true"
                      >
                        <span class="flex min-w-0 items-center gap-2">
                          <span class="truncate">{{ subItem.name }}</span>
                          <UiBadge v-if="subItem.tag" variant="outline" class="border-border/40 bg-muted/20 px-1.5 py-0 text-[10px] lowercase text-muted-foreground/60">
                            {{ subItem.tag }}
                          </UiBadge>
                        </span>
                      </div>
                      <NuxtLink
                        v-else
                        :to="subItemHref(subItem)"
                        :class="[
                          'flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                          isSubItemActive(subItem) ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                        ]"
                        @click="handleNavClick(subItem, $event)"
                      >
                        <span class="flex min-w-0 items-center gap-2">
                          <span class="truncate">{{ subItem.name }}</span>
                          <UiBadge v-if="subItem.tag" variant="outline" class="px-1.5 py-0 text-[10px] lowercase">
                            {{ subItem.tag }}
                          </UiBadge>
                        </span>
                      </NuxtLink>
                    </template>
                  </div>
                </div>
              </nav>
            </div>
          </div>
        </div>
      </template>
    </UiSheet>

    <UiDialog v-model:open="disableSharingDialogOpen" :ui="{ content: 'sm:max-w-[400px]' }">
      <template #content>
        <div class="space-y-1.5 pr-6">
          <h2 class="text-lg font-semibold leading-none tracking-tight">Stop Sharing</h2>
          <p class="text-sm text-muted-foreground">You won't earn points anymore?</p>
        </div>
        <div class="flex justify-end gap-2">
          <UiButton variant="outline" size="sm" @click="cancelDisableSharing">Cancel</UiButton>
          <UiButton variant="destructive" size="sm" @click="disableSharing">Stop</UiButton>
        </div>
      </template>
    </UiDialog>

    <MaintenerAuditDialog v-model:open="auditDialogOpen" @selected="handleAuditSelected" />
  </div>
</template>
