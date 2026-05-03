<script setup lang="ts">
import type {
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
import { buildProviderHrefMap, PROVIDER_ACCOUNT_DEFINITIONS } from "../../lib/provider-accounts";

const route = useRoute();
const { data: session } = await useSession(useFetch);

const mobileOpen = ref(false);
const userMenuOpen = ref(false);
const isModelsExpanded = ref(route.path === "/dashboard/models" || route.path.startsWith("/dashboard/models/"));

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
}

const emptyShellAccountSummary: ShellAccountSummary = {
  accountCounts: { ...emptyAccountCounts },
  activeAccountCounts: { ...emptyAccountCounts },
  accountIndicators: { ...emptyAccountIndicators },
  pinnedProviders: [],
};

const modelFamilyCounts = ref<ModelFamilyCounts>(Object.fromEntries(MODEL_FAMILY_NAV_ITEMS.map((family) => [family.anchorId, 0])));

const supportNavigation: NavItem[] = [
  { name: "Usage", href: "/dashboard/usage", icon: "i-lucide-book-open" },
  { name: "Playground", href: "/dashboard/playground", icon: "i-lucide-flask-conical" },
];

const dashboardApi = useDashboardApi();

const { data: accountSummaryData, pending: accountSummaryPending } = await useAsyncData("dashboard-shell-accounts", async (): Promise<ShellAccountSummary> => {
  const summary = await dashboardApi.accounts.summary();
  const nextAccountCounts = { ...emptyAccountCounts };
  const nextActiveAccountCounts = { ...emptyAccountCounts };
  const nextAccountIndicators = { ...emptyAccountIndicators };

  for (const definition of PROVIDER_ACCOUNT_DEFINITIONS) {
    const providerSummary = summary.summaries[definition.key];
    nextAccountCounts[definition.key] = providerSummary.connected;
    nextActiveAccountCounts[definition.key] = providerSummary.active;
    nextAccountIndicators[definition.key] = providerSummary.indicator;
  }

  return {
    accountCounts: nextAccountCounts,
    activeAccountCounts: nextActiveAccountCounts,
    accountIndicators: nextAccountIndicators,
    pinnedProviders: summary.pinnedProviders,
  };
}, {
  default: () => emptyShellAccountSummary,
});

const accountCounts = computed(() => accountSummaryData.value?.accountCounts ?? emptyShellAccountSummary.accountCounts);
const activeAccountCounts = computed(() => accountSummaryData.value?.activeAccountCounts ?? emptyShellAccountSummary.activeAccountCounts);
const accountIndicators = computed(
  () => accountSummaryData.value?.accountIndicators ?? emptyShellAccountSummary.accountIndicators
);
const pinnedProviders = computed(() => accountSummaryData.value?.pinnedProviders ?? emptyShellAccountSummary.pinnedProviders);
const hasLoadedAccountSummary = computed(() => Boolean(accountSummaryData.value));

const activeAccountCountByHref = computed(() => buildProviderHrefMap(activeAccountCounts.value));
const accountCountByHref = computed(() => buildProviderHrefMap(accountCounts.value));
const accountIndicatorByHref = computed(() => buildProviderHrefMap(accountIndicators.value));

useAsyncData("dashboard-shell-model-family-counts", async () => {
  const counts = await dashboardApi.models.familyCounts();
  const anchorByFamily = new Map(MODEL_FAMILY_NAV_ITEMS.map((family) => [family.name, family.anchorId]));
  const nextCounts = Object.fromEntries(MODEL_FAMILY_NAV_ITEMS.map((family) => [family.anchorId, 0])) as ModelFamilyCounts;

  for (const [rawFamily, count] of Object.entries(counts)) {
    const family = categorizeModelFamily(rawFamily);
    const anchorId = anchorByFamily.get(family);
    if (anchorId) {
      nextCounts[anchorId] = (nextCounts[anchorId] ?? 0) + count;
    }
  }

  modelFamilyCounts.value = nextCounts;
  return true;
});

const pinnedHrefOrder = computed(() => {
  const order = new Map<string, number>();

  pinnedProviders.value.forEach((key, index) => {
    const provider = PROVIDER_ACCOUNT_DEFINITIONS.find((definition) => definition.key === key);

    if (provider) {
      order.set(`/dashboard/accounts/${provider.slug}`, index);
    }
  });

  return order;
});

function isActive(href: string) {
  return route.path === href || (href !== "/dashboard" && route.path.startsWith(href));
}

function subItemHref(subItem: NavSubItem) {
  if (subItem.anchorId) {
    return `${subItem.href}#${subItem.anchorId}`;
  }

  return subItem.href;
}

function isSubItemActive(subItem: NavSubItem) {
  if (subItem.anchorId) {
    return route.path === subItem.href && route.hash === `#${subItem.anchorId}`;
  }

  return route.path === subItem.href || route.path.startsWith(`${subItem.href}/`);
}

function visibleSubItems(item: NavItem) {
  if (!item.children) {
    return [];
  }

  if (item.href === "/dashboard/accounts") {
    return item.children
      .filter((subItem) => pinnedHrefOrder.value.has(subItem.href))
      .sort((a, b) => (pinnedHrefOrder.value.get(a.href) ?? 0) - (pinnedHrefOrder.value.get(b.href) ?? 0));
  }

  if (item.href === "/dashboard/models") {
    return item.children.filter((subItem) => subItem.anchorId ? (modelFamilyCounts.value[subItem.anchorId] ?? 0) > 0 : true);
  }

  return item.children;
}

function modelCountFor(subItem: NavSubItem) {
  return subItem.anchorId ? (modelFamilyCounts.value[subItem.anchorId] ?? 0) : 0;
}

function handleNavClick(item?: NavItem | NavSubItem) {
  if (item && "anchorId" in item && item.anchorId) {
    const target = document.getElementById(item.anchorId);

    if (target && route.path === item.href) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  mobileOpen.value = false;
}

async function handleSignOut() {
  await signOut();
  await navigateTo("/");
}
</script>

<template>
  <div class="relative flex min-h-svh bg-background text-foreground">
    <aside class="hidden border-r border-border bg-card md:sticky md:top-0 md:flex md:h-svh md:w-60 md:flex-col">
      <div class="flex h-16 items-center border-b border-border px-5">
        <NuxtLink to="/dashboard" class="inline-flex items-center gap-2.5">
          <span class="relative flex h-2.5 w-2.5">
            <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
            <span class="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
          </span>
          <span class="text-base font-semibold tracking-tight">Opendum</span>
        </NuxtLink>
      </div>

      <div class="flex min-h-0 flex-1 flex-col px-3 py-4">
        <nav class="min-h-0 flex-1 overflow-y-auto pr-1">
          <div class="space-y-1">
            <div v-for="item in primaryNavigation" :key="item.name" class="space-y-1">
              <div
                v-if="item.href === '/dashboard/models'"
                :class="[
                  'group flex items-center rounded-lg text-sm font-medium transition-all',
                  isActive(item.href) ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                ]"
              >
                <NuxtLink :to="item.href" class="flex flex-1 items-center gap-3 py-2.5 pl-3" @click="handleNavClick(item)">
                  <UiIcon :name="item.icon" :class="['size-4', isActive(item.href) ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground']" />
                  {{ item.name }}
                </NuxtLink>
                <button
                  type="button"
                  class="flex cursor-pointer items-center px-3 py-2.5 text-muted-foreground transition-colors hover:text-foreground"
                  :aria-label="isModelsExpanded ? 'Collapse models' : 'Expand models'"
                  @click="isModelsExpanded = !isModelsExpanded"
                >
                  <UiIcon :name="isModelsExpanded || isActive(item.href) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-3.5" />
                </button>
              </div>

              <NuxtLink
                v-else
                :to="item.href"
                :class="[
                  'group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all',
                  isActive(item.href) ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                ]"
                @click="handleNavClick(item)"
              >
                <UiIcon :name="item.icon" :class="['size-4', isActive(item.href) ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground']" />
                {{ item.name }}
              </NuxtLink>

              <div v-if="item.children?.length && (item.href !== '/dashboard/models' || isModelsExpanded || isActive(item.href))" class="ml-6 space-y-1 border-l border-border/60 pl-3">
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
                      @click="handleNavClick(subItem)"
                    >
                      <span class="flex min-w-0 items-center gap-2">
                        <span class="truncate">{{ subItem.name }}</span>
                        <UiBadge v-if="subItem.tag" variant="outline" class="px-1.5 py-0 text-[10px] lowercase">
                          {{ subItem.tag }}
                        </UiBadge>
                      </span>
                      <span v-if="item.href === '/dashboard/accounts'" class="flex items-center gap-2">
                        <AccountStatusIndicator
                          :account-count="accountCountByHref[subItem.href]"
                          :active-account-count="activeAccountCountByHref[subItem.href]"
                          :indicator="accountIndicatorByHref[subItem.href]"
                        />
                      </span>
                      <span
                        v-else-if="item.href === '/dashboard/models' && subItem.anchorId && modelCountFor(subItem) > 0"
                        :class="[
                          'rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none',
                          isSubItemActive(subItem) ? 'bg-background text-foreground' : 'bg-muted text-muted-foreground',
                        ]"
                      >
                        {{ modelCountFor(subItem) }}
                      </span>
                    </NuxtLink>
                  </template>
                </template>
                <p v-else-if="item.href === '/dashboard/accounts' && hasLoadedAccountSummary && !accountSummaryPending" class="px-2.5 py-1 text-[11px] text-muted-foreground">
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
              :class="[
                'group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all',
                isActive(item.href) ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              ]"
              @click="handleNavClick(item)"
            >
              <UiIcon :name="item.icon" :class="['size-4', isActive(item.href) ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground']" />
              {{ item.name }}
            </NuxtLink>
          </nav>
        </div>
      </div>
    </aside>

    <div class="flex min-w-0 flex-1 flex-col">
      <header class="sticky top-0 z-30 h-16 border-b border-border bg-background px-5 sm:px-6 lg:px-8">
        <div class="flex h-full w-full items-center gap-3 md:gap-0">
          <div class="flex min-w-0 items-center">
            <button
              type="button"
              class="inline-flex size-8 cursor-pointer items-center justify-center rounded-lg border border-border bg-card text-sm font-medium outline-none transition-all hover:bg-accent/50 hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:hidden"
              @click="mobileOpen = true"
            >
              <UiIcon name="i-lucide-menu" class="size-5" />
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

      <main class="flex-1 overflow-y-auto">
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
                <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                <span class="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
              </span>
              Opendum
            </NuxtLink>
            <button type="button" class="cursor-pointer opacity-70 transition-opacity hover:opacity-100 focus:outline-none" @click="mobileOpen = false">
              <UiIcon name="i-lucide-x" class="size-4" />
              <span class="sr-only">Close</span>
            </button>
          </div>

          <div class="flex min-h-0 flex-1 flex-col px-3 py-4">
            <nav class="min-h-0 flex-1 overflow-y-auto pr-1">
              <div class="space-y-1">
                <div v-for="item in primaryNavigation" :key="`mobile-${item.name}`" class="space-y-1">
                  <NuxtLink
                    :to="item.href"
                    :class="[
                      'group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all',
                      isActive(item.href) ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    ]"
                    @click="handleNavClick(item)"
                  >
                    <UiIcon :name="item.icon" :class="['size-4', isActive(item.href) ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground']" />
                    {{ item.name }}
                  </NuxtLink>

                  <div v-if="item.children?.length" class="ml-6 space-y-1 border-l border-border/60 pl-3">
                    <template v-if="visibleSubItems(item).length">
                      <NuxtLink
                        v-for="subItem in visibleSubItems(item)"
                        :key="`mobile-${item.name}-${subItem.name}`"
                        :to="subItemHref(subItem)"
                        :class="[
                          'flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                          subItem.disabled ? 'text-muted-foreground/60' : isSubItemActive(subItem) ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                        ]"
                        @click="handleNavClick(subItem)"
                      >
                        <span class="truncate">{{ subItem.name }}</span>
                        <AccountStatusIndicator
                          v-if="item.href === '/dashboard/accounts'"
                          :account-count="accountCountByHref[subItem.href]"
                          :active-account-count="activeAccountCountByHref[subItem.href]"
                          :indicator="accountIndicatorByHref[subItem.href]"
                        />
                        <span
                          v-else-if="item.href === '/dashboard/models' && subItem.anchorId && modelCountFor(subItem) > 0"
                          :class="[
                            'rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none',
                            isSubItemActive(subItem) ? 'bg-background text-foreground' : 'bg-muted text-muted-foreground',
                          ]"
                        >
                          {{ modelCountFor(subItem) }}
                        </span>
                      </NuxtLink>
                    </template>
                    <p v-else-if="item.href === '/dashboard/accounts' && hasLoadedAccountSummary && !accountSummaryPending" class="px-2.5 py-1 text-[11px] text-muted-foreground">
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
                  :class="[
                    'group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all',
                    isActive(item.href) ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  ]"
                  @click="handleNavClick(item)"
                >
                  <UiIcon :name="item.icon" :class="['size-4', isActive(item.href) ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground']" />
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
