<script setup lang="ts">
definePageMeta({ middleware: "auth", layout: "dashboard" });

const { $client } = useNuxtApp();
const search = ref("");

type ModelListItem = Awaited<ReturnType<typeof $client.models.list.query>>[number];

const { data, error, pending } = await useAsyncData("dashboard-models", () => $client.models.list.query());
const models = computed<ModelListItem[]>(() => data.value ?? []);
const filteredModels = computed(() => models.value.filter((model) => model.id.toLowerCase().includes(search.value.toLowerCase())));

function modelSubtitle(model: ModelListItem): string {
  return model.family ?? (model.providers.join(", ") || "Unified model");
}
</script>

<template>
  <div class="space-y-6">
    <DashboardPageHeader title="Models" description="Browse models exposed by connected provider accounts." :badge="`${filteredModels.length} shown`">
      <template #actions>
        <UInput v-model="search" icon="i-lucide-search" placeholder="Search models" class="w-64" />
      </template>
    </DashboardPageHeader>

    <DashboardDataNotice :error="error" />
    <USkeleton v-if="pending" class="h-96 rounded-xl" />
    <DashboardEmptyState v-else-if="filteredModels.length === 0" title="No models found" description="Connect accounts or adjust your search." icon="i-lucide-cpu" />
    <div v-else class="grid gap-3 lg:grid-cols-2">
      <UCard v-for="model in filteredModels" :key="model.id">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h2 class="truncate font-mono text-sm font-semibold">{{ model.id }}</h2>
            <p class="mt-1 text-sm text-muted-foreground">{{ modelSubtitle(model) }}</p>
          </div>
          <UBadge :color="model.isEnabled === false ? 'neutral' : 'success'" variant="soft">
            {{ model.isEnabled === false ? 'Disabled' : 'Enabled' }}
          </UBadge>
        </div>
      </UCard>
    </div>
  </div>
</template>
