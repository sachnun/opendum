<script setup lang="ts">
definePageMeta({ middleware: "auth", layout: "dashboard" });

const { $client } = useNuxtApp();

interface DashboardOverview {
  requests: number;
  tokens: number;
  errors: number;
}

const { data, error, pending } = await useAsyncData("dashboard-overview", () => $client.analytics.overview.query());

const stats = computed(() => {
  const source = data.value as DashboardOverview | null;
  return [
    { label: "Requests", value: (source?.requests ?? 0).toLocaleString(), icon: "i-lucide-send" },
    { label: "Tokens", value: (source?.tokens ?? 0).toLocaleString(), icon: "i-lucide-binary" },
    { label: "Errors", value: (source?.errors ?? 0).toLocaleString(), icon: "i-lucide-triangle-alert" },
  ];
});
</script>

<template>
  <div class="space-y-6">
    <DashboardPageHeader
      title="Analytics"
      description="A compact overview of request volume, token usage, failures, and key activity."
    >
      <template #actions>
        <UButton to="/dashboard/usage" color="neutral" variant="soft" icon="i-lucide-book-open">
          Usage
        </UButton>
      </template>
    </DashboardPageHeader>

    <DashboardDataNotice :error="error" />

    <div v-if="pending" class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <USkeleton v-for="item in 3" :key="item" class="h-32 rounded-xl" />
    </div>
    <div v-else class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <DashboardStatCard
        v-for="stat in stats"
        :key="stat.label"
        :label="stat.label"
        :value="stat.value"
        :icon="stat.icon"
      />
    </div>

    <UCard>
      <div class="space-y-3">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h2 class="font-semibold">Recent activity</h2>
            <p class="text-sm text-muted-foreground">Detailed charts can be wired to the analytics tRPC procedures.</p>
          </div>
          <UIcon name="i-lucide-chart-spline" class="size-5 text-muted-foreground" />
        </div>
        <div class="grid h-44 grid-cols-12 items-end gap-2 rounded-lg border border-border bg-muted/20 p-4">
          <div
            v-for="height in [24, 42, 36, 68, 54, 86, 72, 96, 60, 78, 90, 64]"
            :key="height"
            class="rounded-t bg-primary/70"
            :style="{ height: `${height}%` }"
          />
        </div>
      </div>
    </UCard>
  </div>
</template>
