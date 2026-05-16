<script setup lang="ts">
import type {
  AccountPingData,
  AccountSummaryData,
  ModelFamilyCounts,
  NavItem,
  NavSubItem,
  ProviderAccountCounts,
  ProviderAccountIndicators,
} from "../../lib/navigation";
import { MODEL_FAMILY_NAV_ITEMS, categorizeModelFamily } from "../../lib/model-families";
import { primaryNavigation } from "../../lib/navigation";
import { signOut, useSession } from "../../lib/auth-client";
import type { ProviderAccountKey } from "../../lib/provider-accounts";
import { buildProviderHrefMap, getProviderAccountPath, PROVIDER_ACCOUNT_DEFINITIONS } from "../../lib/provider-accounts";

const route = useRoute();
const { data: session } = await useSession(useFetch);

const mobileOpen = ref(false);
const userMenuOpen = ref(false);
const mainContent = ref<HTMLElement | null>(null);
const activeAnchorId = ref<string | null>(null);

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

const supportNavigation = computed<NavItem[]>(() => [
  { name: "Playground", href: "/dashboard/playground", icon: "i-lucide-flask-conical", disabled: playgroundNavigationDisabled.value },
]);
const PROVIDER_AVAILABILITY_ORDER = { active: 0, inactive: 1 } as const;
const PROVIDER_STATUS_ORDER = { error: 0, warning: 1, normal: 2 } as const;

const dashboardApi = useDashboardApi();
const accountsNavigationHref = getProviderAccountPath("codex");

const { data: dashboardMe } = await useAsyncData("dashboard-me", () => dashboardApi.me.get(), {
  default: () => ({ role: "user" as const, isMaintener: false }),
});
const isMaintener = computed(() => dashboardMe.value?.isMaintener ?? false);

function toShellAccountSummary(summary: AccountSummaryData | AccountPingData): ShellAccountSummary {
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

const { data: accountSummaryData, pending: accountSummaryPending, refresh: refreshAccountSummary } = await useAsyncData("dashboard-shell-accounts", async (): Promise<ShellAccountSummary> => {
  const summary = await dashboardApi.accounts.ping();
  return toShellAccountSummary(summary);
}, {
  default: () => emptyShellAccountSummary,
});

const accountCounts = computed(() => accountSummaryData.value?.accountCounts ?? emptyShellAccountSummary.accountCounts);
const activeAccountCounts = computed(() => accountSummaryData.value?.activeAccountCounts ?? emptyShellAccountSummary.activeAccountCounts);
const accountIndicators = computed(
  () => accountSummaryData.value?.accountIndicators ?? emptyShellAccountSummary.accountIndicators
);
const pinnedProviders = computed(() => accountSummaryData.value?.pinnedProviders ?? emptyShellAccountSummary.pinnedProviders);
const hasConnectedAccounts = computed(() => accountSummaryData.value?.hasConnectedAccounts ?? emptyShellAccountSummary.hasConnectedAccounts);
const hasLoadedAccountSummary = computed(() => Boolean(accountSummaryData.value));

const activeAccountCountByHref = computed(() => buildProviderHrefMap(activeAccountCounts.value));
const accountCountByHref = computed(() => buildProviderHrefMap(accountCounts.value));
const accountIndicatorByHref = computed(() => buildProviderHrefMap(accountIndicators.value));
const accountNavigationHrefs = computed(() => new Set(PROVIDER_ACCOUNT_DEFINITIONS.map((definition) => getProviderAccountPath(definition.key))));
const playgroundNavigationDisabled = computed(() => hasLoadedAccountSummary.value && !accountSummaryPending.value && !hasConnectedAccounts.value);

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
let accountSummaryRefreshTimer: ReturnType<typeof setInterval> | null = null;
let accountSummaryRefreshInFlight: Promise<void> | null = null;
let accountSummaryRefreshQueued = false;

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

function isActive(href: string) {
  if (href === accountsNavigationHref && accountNavigationHrefs.value.has(route.path)) return true;
  return route.path === href || (href !== "/dashboard" && route.path.startsWith(href));
}

function isAccountsNavItem(item: NavItem) {
  return item.href === accountsNavigationHref;
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

async function refreshAccountSummaryOnce() {
  if (accountSummaryRefreshInFlight) {
    accountSummaryRefreshQueued = true;
    return;
  }

  accountSummaryRefreshInFlight = refreshAccountSummary().then(() => undefined);
  try {
    await accountSummaryRefreshInFlight;
  } finally {
    accountSummaryRefreshInFlight = null;
    if (accountSummaryRefreshQueued) {
      accountSummaryRefreshQueued = false;
      void refreshAccountSummaryOnce();
    }
  }
}

onMounted(() => {
  accountSummaryRefreshTimer = setInterval(() => {
    void refreshAccountSummaryOnce();
  }, ACCOUNT_SUMMARY_REFRESH_MS);

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
  if (accountSummaryRefreshTimer) clearInterval(accountSummaryRefreshTimer);
});

async function handleSignOut() {
  await signOut();
  await navigateTo("/");
}
</script>

<template>
  <div class="relative flex h-svh overflow-hidden bg-background text-foreground">
    <aside class="hidden border-r border-border bg-card md:flex md:h-svh md:w-60 md:shrink-0 md:flex-col">
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
        <nav class="min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
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
                      class="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground/60"
                      aria-disabled="true"
                    >
                      <span class="flex min-w-0 items-center gap-2">
                        <span class="truncate">{{ subItem.name }}</span>
                        <UiBadge v-if="subItem.tag" variant="outline" class="px-1.5 py-0 text-[10px] lowercase">
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
                <p v-else-if="isAccountsNavItem(item) && hasLoadedAccountSummary && !accountSummaryPending" class="px-2.5 py-1 text-[11px] text-muted-foreground">
                  No pinned providers.
                </p>
              </div>
            </div>
          </div>
        </nav>

        <div class="shrink-0">
          <nav class="mt-4 space-y-1 border-t border-border/60 pt-4">
            <NuxtLink
              v-for="item in supportNavigation"
              :key="item.name"
              :to="item.href"
              :aria-disabled="item.disabled ? true : undefined"
              :class="[
                'group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all',
                item.disabled ? 'cursor-not-allowed text-muted-foreground/45' : isActive(item.href) ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              ]"
              @click="handleNavClick(item, $event)"
            >
              <UiIcon :name="item.icon" :class="['size-4', item.disabled ? 'text-muted-foreground/45' : isActive(item.href) ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground']" />
              {{ item.name }}
            </NuxtLink>
          </nav>
        </div>
      </div>
    </aside>

    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
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
            <ModelSearchPopover />
          </div>

          <div class="flex items-center gap-1.5 sm:gap-2">
            <UiPopover v-model:open="userMenuOpen" :content="{ align: 'end', sideOffset: 8 }">
              <button
                type="button"
                class="flex cursor-pointer items-center justify-center rounded-full transition-opacity hover:opacity-80"
              >
                <span class="relative flex size-8 shrink-0 overflow-hidden rounded-full select-none">
                  <img v-if="userImage" :src="userImage" alt="" class="aspect-square size-full">
                  <span v-else class="flex size-full items-center justify-center rounded-full bg-muted text-sm text-muted-foreground">
                    {{ userInitial }}
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
                  <div class="-mx-1 my-1 h-px bg-border" />
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

      <main ref="mainContent" class="min-h-0 flex-1 overflow-y-auto">
        <div class="w-full px-5 pb-8 pt-5 sm:px-6 lg:px-8">
          <slot />
        </div>
      </main>
    </div>

    <UiSheet v-model:open="mobileOpen" side="left" :ui="{ content: 'w-[78vw] max-w-[18rem] p-0' }">
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
            <nav class="min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
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
                          class="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground/60"
                          aria-disabled="true"
                        >
                          <span class="flex min-w-0 items-center gap-2">
                            <span class="truncate">{{ subItem.name }}</span>
                            <UiBadge v-if="subItem.tag" variant="outline" class="px-1.5 py-0 text-[10px] lowercase">
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
                    <p v-else-if="isAccountsNavItem(item) && hasLoadedAccountSummary && !accountSummaryPending" class="px-2.5 py-1 text-[11px] text-muted-foreground">
                      No pinned providers.
                    </p>
                  </div>
                </div>
              </div>
            </nav>

            <div class="shrink-0">
              <nav class="mt-4 space-y-1 border-t border-border/60 pt-4">
                <NuxtLink
                  v-for="item in supportNavigation"
                  :key="`mobile-${item.name}`"
                  :to="item.href"
                  :aria-disabled="item.disabled ? true : undefined"
                  :class="[
                    'group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all',
                    item.disabled ? 'cursor-not-allowed text-muted-foreground/45' : isActive(item.href) ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  ]"
                  @click="handleNavClick(item, $event)"
                >
                  <UiIcon :name="item.icon" :class="['size-4', item.disabled ? 'text-muted-foreground/45' : isActive(item.href) ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground']" />
                  {{ item.name }}
                </NuxtLink>
              </nav>
            </div>
          </div>
        </div>
      </template>
    </UiSheet>
  </div>
</template>
