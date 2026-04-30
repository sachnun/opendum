<script setup lang="ts">
import { format } from "date-fns";

const props = defineProps<{
  apiKeyId: string;
  initialExpiresAt: string | Date | null;
}>();

const emit = defineEmits<{
  updated: [];
}>();

const { $client } = useNuxtApp();
const open = ref(false);
const isSaving = ref(false);
const expiresAt = ref<Date | null>(props.initialExpiresAt ? new Date(props.initialExpiresAt) : null);
const draftDate = ref(expiresAt.value ? format(expiresAt.value, "yyyy-MM-dd") : "");
const errorMessage = ref("");

watch(open, (value) => {
  if (value) {
    draftDate.value = expiresAt.value ? format(expiresAt.value, "yyyy-MM-dd") : "";
    errorMessage.value = "";
  }
});

const isExpired = computed(() => expiresAt.value != null && expiresAt.value < new Date());
const displayText = computed(() => (expiresAt.value ? format(expiresAt.value, "MMM d, yyyy") : "No expiry"));

function parseDraftDate(): Date | null {
  if (!draftDate.value) return null;
  const date = new Date(`${draftDate.value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function saveExpiration(value: Date | null) {
  isSaving.value = true;
  errorMessage.value = "";
  try {
    const result = await $client.apiKeys.updateExpiration.mutate({ id: props.apiKeyId, expiresAt: value });
    if (!result.success) throw new Error(result.error);
    expiresAt.value = result.data.expiresAt ? new Date(result.data.expiresAt) : null;
    open.value = false;
    emit("updated");
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Failed to update expiration";
  } finally {
    isSaving.value = false;
  }
}
</script>

<template>
  <UiPopover v-model:open="open" :content="{ align: 'start', class: 'w-72 p-0' }">
    <button
      type="button"
      :class="[
        'inline-flex cursor-pointer items-center gap-1 text-sm transition-colors hover:text-primary disabled:pointer-events-none disabled:opacity-50',
        isExpired ? 'text-destructive' : 'text-muted-foreground',
      ]"
      :disabled="isSaving"
    >
      <UiIcon name="i-lucide-calendar" class="size-3" />
      <span>{{ displayText }}</span>
    </button>
    <template #content>
      <div class="space-y-3 p-3">
        <label class="grid gap-1.5 text-xs font-medium text-muted-foreground">
          Expiration date
          <input v-model="draftDate" type="date" class="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
        </label>
        <p v-if="errorMessage" class="text-xs text-destructive">{{ errorMessage }}</p>
        <div class="flex items-center justify-between gap-2 border-t pt-2">
          <UiButton variant="ghost" size="sm" class="h-7 gap-1 text-xs" :disabled="isSaving || !expiresAt" @click="saveExpiration(null)">
            <UiIcon name="i-lucide-x" class="size-3" />
            Remove expiration
          </UiButton>
          <UiButton size="sm" class="h-7 text-xs" :disabled="isSaving" @click="saveExpiration(parseDraftDate())">
            Save
          </UiButton>
        </div>
      </div>
    </template>
  </UiPopover>
</template>
