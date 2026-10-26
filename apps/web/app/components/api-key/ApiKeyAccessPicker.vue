<script setup lang="ts">
import { sameList, type AccessMode } from "~~/lib/access-draft";

type AccessTarget = { id: string; label: string; detail?: string; mono?: boolean };

const props = defineProps<{
  title: string;
  noun: string;
  targets: AccessTarget[];
  searchText: (target: AccessTarget) => string;
  initialMode: AccessMode;
  initialIds: string[];
  readonly?: boolean;
  normalize: (ids: string[]) => string[];
}>();

const emit = defineEmits<{
  save: [value: { mode: AccessMode; ids: string[] }];
  reset: [];
}>();

const mode = defineModel<AccessMode>("mode", { required: true });
const ids = defineModel<string[]>("ids", { required: true });
const search = defineModel<string>("search", { default: "" });
const pickerOpen = defineModel<boolean>("pickerOpen", { default: false });
const isSaving = defineModel<boolean>("saving", { default: false });
const error = defineModel<string>("error", { default: "" });

const saved = defineModel<{ mode: AccessMode; ids: string[] }>("saved", { required: true });

const normalizedIds = computed(() => props.normalize(ids.value));
const idsForSave = computed(() => (mode.value === "all" ? [] : normalizedIds.value));
const savedIds = computed(() => (saved.value.mode === "all" ? [] : props.normalize(saved.value.ids)));
const hasChanges = computed(
  () => mode.value !== saved.value.mode || !sameList(idsForSave.value, savedIds.value)
);
const targetMap = computed(() => new Map(props.targets.map((target) => [target.id, target])));
const filtered = computed(() => {
  const query = search.value.trim().toLowerCase();
  if (!query) return props.targets;
  return props.targets.filter((target) => props.searchText(target).toLowerCase().includes(query));
});

function toggle(id: string) {
  if (props.readonly) return;
  ids.value = ids.value.includes(id)
    ? ids.value.filter((entry) => entry !== id)
    : props.normalize([...ids.value, id]);
}

function clear() {
  if (props.readonly) return;
  ids.value = [];
}

function labelOf(id: string): string {
  return targetMap.value.get(id)?.label ?? id;
}

function reset() {
  mode.value = saved.value.mode;
  ids.value = [...saved.value.ids];
  pickerOpen.value = false;
  search.value = "";
  error.value = "";
  emit("reset");
}

function submit() {
  if (props.readonly) return;
  if (mode.value !== "all" && idsForSave.value.length === 0) {
    error.value = `Select at least one ${props.noun}`;
    return;
  }
  emit("save", { mode: mode.value, ids: idsForSave.value });
}

defineExpose({ hasChanges, submit, reset });
</script>

<template>
  <section class="flex h-full flex-col">
    <div class="flex-1 space-y-3">
      <div class="grid grid-cols-3 gap-1 rounded-md border border-border/70 bg-card/30 p-1">
        <button v-for="entry in (['all', 'whitelist', 'blacklist'] as AccessMode[])" :key="entry" type="button" :disabled="readonly" :class="['h-8 rounded-sm border px-2 text-xs font-medium disabled:cursor-default disabled:pointer-events-none disabled:opacity-60', mode === entry ? 'border-primary/35 bg-primary/10 text-primary' : 'border-transparent text-muted-foreground']" @click="mode = entry">
          {{ entry === 'all' ? 'All' : entry === 'whitelist' ? 'Whitelist' : 'Blacklist' }}
        </button>
      </div>

      <div v-if="mode !== 'all'" class="space-y-2">
        <div class="flex items-center justify-between gap-2">
          <p class="text-xs font-medium">{{ title }}</p>
          <UiButton type="button" variant="ghost" size="sm" class="h-7 px-2 text-[11px]" :disabled="normalizedIds.length === 0 || isSaving || readonly" @click="clear">Clear</UiButton>
        </div>

        <UiPopover v-model:open="pickerOpen" :content="{ align: 'start', class: 'w-[min(90vw,28rem)] p-0' }">
          <UiButton variant="outline" class="h-9 w-full justify-between px-3 text-xs" :disabled="isSaving || readonly">
            <span class="truncate">{{ normalizedIds.length > 0 ? `${normalizedIds.length} ${noun} selected` : `Select ${noun}s` }}</span>
            <UiIcon name="i-lucide-chevron-down" class="size-3.5 text-muted-foreground" />
          </UiButton>
          <template #content>
            <div class="border-b border-border p-2">
              <input v-model="search" :placeholder="`Search ${noun}...`" class="h-8 w-full rounded-md bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring">
            </div>
            <div class="max-h-72 overflow-y-auto p-1">
              <button v-for="target in filtered" :key="target.id" type="button" :disabled="readonly" class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent disabled:cursor-default disabled:pointer-events-none disabled:opacity-60" @click="toggle(target.id)">
                <UiIcon name="i-lucide-check" :class="['size-3.5', normalizedIds.includes(target.id) ? 'opacity-100' : 'opacity-0']" />
                <div class="flex min-w-0 flex-col">
                  <span :class="['truncate text-xs font-medium', target.mono ? 'font-mono' : '']">{{ target.label }}</span>
                  <span v-if="target.detail" class="truncate text-[11px] text-muted-foreground">{{ target.detail }}</span>
                </div>
              </button>
              <p v-if="filtered.length === 0" class="px-2 py-6 text-center text-xs text-muted-foreground">No {{ noun }} found.</p>
            </div>
          </template>
        </UiPopover>

        <div class="max-h-40 overflow-y-auto py-1">
          <p v-if="normalizedIds.length === 0" class="px-1 text-[11px] text-muted-foreground">No {{ noun }}s selected</p>
          <div v-else class="flex flex-wrap gap-1.5">
            <UiBadge v-for="targetId in normalizedIds" :key="targetId" variant="outline" class="max-w-full gap-1 pr-1 text-[10px] font-normal">
              <span class="min-w-0 truncate">{{ labelOf(targetId) }}</span>
              <UiTooltip text="Remove" :disabled="readonly">
                <button type="button" :disabled="readonly" :aria-label="`Remove ${noun} ${labelOf(targetId)}`" class="inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground disabled:cursor-default disabled:pointer-events-none disabled:opacity-60" @click="toggle(targetId)">
                  <UiIcon name="i-lucide-x" class="size-2.5" />
                </button>
              </UiTooltip>
            </UiBadge>
          </div>
        </div>
      </div>
      <p v-if="error" class="text-xs text-destructive">{{ error }}</p>
    </div>

    <div class="flex items-center justify-end gap-2 border-t border-border/60 pt-3 lg:mt-4">
      <UiButton variant="outline" size="sm" :disabled="isSaving || !hasChanges || readonly" @click="reset">Cancel</UiButton>
      <UiButton size="sm" :disabled="isSaving || !hasChanges || readonly" @click="submit">{{ isSaving ? 'Saving...' : 'Save' }}</UiButton>
    </div>
  </section>
</template>
