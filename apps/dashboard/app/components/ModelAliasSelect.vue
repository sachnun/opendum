<script setup lang="ts">
defineProps<{
  modelValue: string;
  defaultId?: string;
}>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const MAX_RESULTS = 200;
const api = useApi();
const open = ref(false);
const search = ref("");
const searchInput = ref<HTMLInputElement | null>(null);
const { data: catalog, pending } = useCachedData(dataKeys.modelCatalog, () => api.models.catalog(), { default: () => [] as string[] });

const models = computed(() => catalog.value ?? []);
const filteredModels = computed(() => {
  const term = search.value.trim().toLowerCase();
  const matched = term ? models.value.filter((id) => id.toLowerCase().includes(term)) : models.value;
  return matched.slice(0, MAX_RESULTS);
});

watch(open, (value) => {
  search.value = "";
  if (value) void nextTick(() => searchInput.value?.focus());
});

function select(value: string) {
  emit("update:modelValue", value);
  open.value = false;
}
</script>

<template>
  <UiPopover v-model:open="open" :content="{ align: 'start', class: 'w-[min(90vw,28rem)] p-0' }">
    <button
      type="button"
      class="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-left text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <span :class="['truncate font-mono text-xs', modelValue ? '' : 'text-muted-foreground']">{{ modelValue || "None" }}</span>
      <UiIcon name="i-lucide-chevron-down" class="size-3.5 shrink-0 text-muted-foreground" />
    </button>
    <template #content>
      <div class="border-b border-border p-2">
        <input ref="searchInput" v-model="search" placeholder="Search model..." class="h-8 w-full rounded-md bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring">
      </div>
      <div class="max-h-72 overflow-y-auto p-1">
        <button type="button" class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent" @click="select('')">
          <UiIcon name="i-lucide-check" :class="['size-3.5', modelValue ? 'opacity-0' : 'opacity-100']" />
          <span class="truncate text-xs text-muted-foreground">None<span v-if="defaultId"> · uses {{ defaultId }}</span></span>
        </button>
        <button v-for="id in filteredModels" :key="id" type="button" class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent" @click="select(id)">
          <UiIcon name="i-lucide-check" :class="['size-3.5', modelValue === id ? 'opacity-100' : 'opacity-0']" />
          <span class="truncate font-mono text-[11px]">{{ id }}</span>
        </button>
        <p v-if="filteredModels.length === 0" class="px-2 py-6 text-center text-xs text-muted-foreground">{{ pending ? "Loading models..." : "No model found." }}</p>
      </div>
    </template>
  </UiPopover>
</template>
