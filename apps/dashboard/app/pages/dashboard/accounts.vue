<script setup lang="ts">
import type { ProviderAccountIndicator } from "../../../lib/navigation";
import {
  API_KEY_DEFINITIONS,
  OAUTH_DEFINITIONS,
  type ProviderAccountDefinition,
  getProviderAccountPath,
} from "../../../lib/provider-accounts";

definePageMeta({ middleware: "auth", layout: "dashboard" });

const { $client } = useNuxtApp();

type ProviderAccountListItem = Awaited<ReturnType<typeof $client.accounts.list.query>>[number];

const { data, error, pending } = await useAsyncData("dashboard-accounts", () => $client.accounts.list.query());
const accounts = computed<ProviderAccountListItem[]>(() => data.value ?? []);

function countFor(provider: string) {
  return accounts.value.filter((account) => account.provider === provider).length;
}

function activeCountFor(provider: string) {
  return accounts.value.filter((account) => account.provider === provider && account.isActive).length;
}

function indicatorFor(provider: string): ProviderAccountIndicator {
  return accounts.value.some((account) => account.provider === provider && account.lastErrorAt) ? "warning" : "normal";
}

function indicatorBadge(indicator: ProviderAccountIndicator, connectedAccounts: number) {
  if (connectedAccounts === 0) {
    return { label: "No Accounts", class: "" };
  }

  if (indicator === "error") {
    return { label: "Needs Attention", class: "border-transparent bg-destructive/60 text-white" };
  }

  if (indicator === "warning") {
    return { label: "Recovering", class: "border-yellow-500 text-yellow-600" };
  }

  return { label: "Healthy", class: "border-green-500 text-green-600" };
}

function dailyValues() {
  return Array.from({ length: 30 }, () => 0);
}

function providerCardProps(provider: ProviderAccountDefinition) {
  const connected = countFor(provider.key);
  const active = activeCountFor(provider.key);
  const indicator = indicatorFor(provider.key);
  const badge = indicatorBadge(indicator, connected);

  return { connected, active, badge };
}
</script>

<template>
  <div class="space-y-6">
    <div class="sticky top-0 z-20 -mx-5 bg-background px-5 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
      <div class="border-b border-border pb-4 pt-3">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 class="text-xl font-semibold">Provider Accounts</h2>
          </div>
          <div class="flex w-full items-center gap-2 sm:w-auto">
            <UiButton class="flex-1 sm:w-auto sm:flex-none" disabled>
              <UIcon name="i-lucide-plus" class="size-4" />
              Add account
            </UiButton>
          </div>
        </div>
      </div>
    </div>

    <DashboardDataNotice :error="error" />
    <UiSkeleton v-if="pending" class="h-96 rounded-xl" />
    <template v-else>
      <section class="space-y-4 md:space-y-2">
        <div class="space-y-1">
          <h3 class="text-base font-semibold">OAuth Provider Accounts</h3>
        </div>
        <div class="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
          <NuxtLink v-for="provider in OAUTH_DEFINITIONS" :key="provider.key" :to="getProviderAccountPath(provider.key)" class="group block">
            <UiCard class="h-full transition-colors group-hover:border-primary/40">
              <UiCardHeader class="space-y-1 pb-3">
                <div class="flex items-start justify-between gap-2">
                  <div class="flex items-center gap-1">
                    <button type="button" class="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" @click.prevent>
                      <UIcon name="i-lucide-pin" class="size-3.5" />
                    </button>
                    <UiCardTitle class="text-base">{{ provider.label }}</UiCardTitle>
                  </div>
                  <UiBadge variant="outline" :class="providerCardProps(provider).badge.class">
                    {{ providerCardProps(provider).badge.label }}
                  </UiBadge>
                </div>
              </UiCardHeader>
              <UiCardContent class="space-y-3">
                <div class="flex items-center justify-between gap-2">
                  <div class="flex flex-wrap gap-2">
                    <UiBadge variant="secondary">{{ providerCardProps(provider).connected }} connected</UiBadge>
                    <UiBadge variant="outline">{{ providerCardProps(provider).active }} active</UiBadge>
                  </div>
                  <UIcon name="i-lucide-arrow-right" class="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </div>

                <div class="space-y-2 rounded-md border border-border/70 bg-muted/20 p-2.5">
                  <div class="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span class="inline-flex items-center gap-1">
                      <UIcon name="i-lucide-bar-chart-3" class="size-3" />
                      30d
                    </span>
                    <span class="tabular-nums">0 peak</span>
                  </div>

                  <div class="grid grid-cols-3 gap-1.5">
                    <div class="rounded border border-border/60 bg-background/70 px-2 py-1.5">
                      <p class="truncate text-[10px] text-muted-foreground">Requests</p>
                      <p class="truncate text-sm font-semibold tabular-nums text-foreground">0</p>
                    </div>
                    <div class="rounded border border-border/60 bg-background/70 px-2 py-1.5">
                      <p class="truncate text-[10px] text-muted-foreground">Success</p>
                      <p class="truncate text-sm font-semibold tabular-nums text-foreground">-</p>
                    </div>
                    <div class="rounded border border-border/60 bg-background/70 px-2 py-1.5">
                      <p class="truncate text-[10px] text-muted-foreground">Latency</p>
                      <p class="truncate text-sm font-semibold tabular-nums text-foreground">-</p>
                    </div>
                  </div>

                  <div class="rounded border border-border/60 bg-background/70 px-2 py-1.5">
                    <UsageSparkline :values="dailyValues()" color="var(--chart-2)" :aria-label="`Average duration trend for ${provider.label} over last 24 hours`" empty-label="No duration data" class="h-6" :height="24" />
                    <div class="mt-0.5 grid grid-cols-3 text-[9px] text-muted-foreground">
                      <span class="truncate text-center">00:00</span>
                      <span class="truncate text-center">12:00</span>
                      <span class="truncate text-center">23:00</span>
                    </div>
                  </div>

                  <UsageSparkline :values="dailyValues()" color="var(--chart-1)" :aria-label="`Requests trend for ${provider.label}`" />
                </div>
              </UiCardContent>
            </UiCard>
          </NuxtLink>
        </div>
      </section>

      <section class="space-y-4 md:space-y-2">
        <div class="space-y-1">
          <h3 class="text-base font-semibold">API Key Provider Accounts</h3>
        </div>
        <div class="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
          <NuxtLink v-for="provider in API_KEY_DEFINITIONS" :key="provider.key" :to="getProviderAccountPath(provider.key)" class="group block">
            <UiCard class="h-full transition-colors group-hover:border-primary/40">
              <UiCardHeader class="space-y-1 pb-3">
                <div class="flex items-start justify-between gap-2">
                  <div class="flex items-center gap-1">
                    <button type="button" class="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" @click.prevent>
                      <UIcon name="i-lucide-pin" class="size-3.5" />
                    </button>
                    <UiCardTitle class="text-base">{{ provider.label }}</UiCardTitle>
                  </div>
                  <UiBadge variant="outline" :class="providerCardProps(provider).badge.class">
                    {{ providerCardProps(provider).badge.label }}
                  </UiBadge>
                </div>
              </UiCardHeader>
              <UiCardContent class="space-y-3">
                <div class="flex items-center justify-between gap-2">
                  <div class="flex flex-wrap gap-2">
                    <UiBadge variant="secondary">{{ providerCardProps(provider).connected }} connected</UiBadge>
                    <UiBadge variant="outline">{{ providerCardProps(provider).active }} active</UiBadge>
                  </div>
                  <UIcon name="i-lucide-arrow-right" class="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </div>

                <div class="space-y-2 rounded-md border border-border/70 bg-muted/20 p-2.5">
                  <div class="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span class="inline-flex items-center gap-1">
                      <UIcon name="i-lucide-bar-chart-3" class="size-3" />
                      30d
                    </span>
                    <span class="tabular-nums">0 peak</span>
                  </div>

                  <div class="grid grid-cols-3 gap-1.5">
                    <div class="rounded border border-border/60 bg-background/70 px-2 py-1.5">
                      <p class="truncate text-[10px] text-muted-foreground">Requests</p>
                      <p class="truncate text-sm font-semibold tabular-nums text-foreground">0</p>
                    </div>
                    <div class="rounded border border-border/60 bg-background/70 px-2 py-1.5">
                      <p class="truncate text-[10px] text-muted-foreground">Success</p>
                      <p class="truncate text-sm font-semibold tabular-nums text-foreground">-</p>
                    </div>
                    <div class="rounded border border-border/60 bg-background/70 px-2 py-1.5">
                      <p class="truncate text-[10px] text-muted-foreground">Latency</p>
                      <p class="truncate text-sm font-semibold tabular-nums text-foreground">-</p>
                    </div>
                  </div>

                  <div class="rounded border border-border/60 bg-background/70 px-2 py-1.5">
                    <UsageSparkline :values="dailyValues()" color="var(--chart-2)" :aria-label="`Average duration trend for ${provider.label} over last 24 hours`" empty-label="No duration data" class="h-6" :height="24" />
                    <div class="mt-0.5 grid grid-cols-3 text-[9px] text-muted-foreground">
                      <span class="truncate text-center">00:00</span>
                      <span class="truncate text-center">12:00</span>
                      <span class="truncate text-center">23:00</span>
                    </div>
                  </div>

                  <UsageSparkline :values="dailyValues()" color="var(--chart-1)" :aria-label="`Requests trend for ${provider.label}`" />
                </div>
              </UiCardContent>
            </UiCard>
          </NuxtLink>
        </div>
      </section>
    </template>
  </div>
</template>
