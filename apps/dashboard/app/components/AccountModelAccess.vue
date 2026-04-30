<script setup lang="ts">
const props = defineProps<{
  accountId: string;
  supportedModels: string[];
  initialDisabledModels: string[];
}>();

const dashboardApi = useDashboardApi();
const disabledModels = ref(new Set(props.initialDisabledModels));
const togglingModels = ref(new Set<string>());
const expanded = ref(false);
const visibleCount = 5;

watch(
  () => props.initialDisabledModels,
  (models) => {
    disabledModels.value = new Set(models);
  }
);

const enabledCount = computed(() => props.supportedModels.length - disabledModels.value.size);
const hasMore = computed(() => props.supportedModels.length > visibleCount);
const visibleModels = computed(() => (expanded.value ? props.supportedModels : props.supportedModels.slice(0, visibleCount)));
const hiddenCount = computed(() => props.supportedModels.length - visibleCount);

async function toggleModel(model: string) {
  const currentlyEnabled = !disabledModels.value.has(model);
  const enabled = !currentlyEnabled;
  const previous = new Set(disabledModels.value);
  const next = new Set(disabledModels.value);

  if (enabled) next.delete(model);
  else next.add(model);

  disabledModels.value = next;
  togglingModels.value = new Set(togglingModels.value).add(model);

  try {
    const result = await dashboardApi.accounts.setAccountModelEnabled({ accountId: props.accountId, modelId: model, enabled });
    if (!result.success) throw new Error(result.error);
  } catch {
    disabledModels.value = previous;
  } finally {
    const pending = new Set(togglingModels.value);
    pending.delete(model);
    togglingModels.value = pending;
  }
}
</script>

<template>
  <div v-if="supportedModels.length" class="mt-3 space-y-2 border-t pt-3">
    <div class="flex items-center justify-between gap-2">
      <span class="text-xs font-medium text-muted-foreground">Model Access</span>
      <span class="text-xs text-muted-foreground">{{ enabledCount }}/{{ supportedModels.length }}</span>
    </div>
    <div class="flex flex-wrap gap-1.5">
      <button
        v-for="model in visibleModels"
        :key="model"
        type="button"
        :disabled="togglingModels.has(model)"
        :title="disabledModels.has(model) ? `Enable ${model}` : `Disable ${model}`"
        :class="[
          'inline-flex cursor-pointer items-center rounded-md px-2 py-0.5 font-mono text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
          disabledModels.has(model) ? 'bg-transparent text-muted-foreground/60 line-through' : 'bg-muted text-foreground',
        ]"
        @click="toggleModel(model)"
      >
        {{ model }}
      </button>
      <button v-if="hasMore" type="button" class="inline-flex cursor-pointer items-center rounded-md px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" @click="expanded = !expanded">
        {{ expanded ? 'Show less' : `+${hiddenCount} more` }}
      </button>
    </div>
  </div>
</template>
