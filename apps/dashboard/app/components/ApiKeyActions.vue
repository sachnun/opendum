<script setup lang="ts">
import { cn } from "../../lib/utils";
import type { ApiKeyListItem } from "../../lib/dashboard-api-types";

type ApiKey = ApiKeyListItem;

const props = defineProps<{
  apiKey: ApiKey;
}>();

const emit = defineEmits<{
  changed: [];
}>();

const dashboardApi = useDashboardApi();
const isDeleting = ref(false);
const deleteDialogOpen = ref(false);
const isRevealed = ref(false);
const revealedKey = ref<string | null>(null);
const isLoading = ref(false);
const copied = ref(false);
const errorMessage = ref("");

const displayKey = computed(() => (isRevealed.value && revealedKey.value ? revealedKey.value : `${props.apiKey.keyPreview.substring(0, 8)}********`));

async function revealKey() {
  if (isRevealed.value) {
    isRevealed.value = false;
    revealedKey.value = null;
    return;
  }

  isLoading.value = true;
  errorMessage.value = "";
  try {
    const result = await dashboardApi.apiKeys.reveal({ id: props.apiKey.id });
    if (!result.success) throw new Error(result.error);
    revealedKey.value = result.data.key;
    isRevealed.value = true;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Failed to reveal API key";
  } finally {
    isLoading.value = false;
  }
}

async function copyKey() {
  let key = revealedKey.value;
  isLoading.value = true;
  errorMessage.value = "";
  try {
    if (!key) {
      const result = await dashboardApi.apiKeys.reveal({ id: props.apiKey.id });
      if (!result.success) throw new Error(result.error);
      key = result.data.key;
    }
    await navigator.clipboard.writeText(key);
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Failed to copy API key";
  } finally {
    isLoading.value = false;
  }
}

async function deleteKey() {
  isDeleting.value = true;
  errorMessage.value = "";
  try {
    const result = await dashboardApi.apiKeys.delete({ id: props.apiKey.id });
    if (!result.success) throw new Error(result.error);
    deleteDialogOpen.value = false;
    emit("changed");
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Failed to delete API key";
  } finally {
    isDeleting.value = false;
  }
}
</script>

<template>
  <div>
    <div class="flex flex-col gap-2.5">
      <p v-if="errorMessage" class="text-xs text-destructive">{{ errorMessage }}</p>
      <button
        type="button"
        :disabled="isLoading"
        :class="cn(
          'flex w-full cursor-pointer items-center gap-2 rounded-sm border border-border/60 bg-transparent px-2 py-2 text-left font-mono text-xs text-muted-foreground outline-none transition-colors hover:bg-muted/30 disabled:pointer-events-none disabled:opacity-50',
          isRevealed ? 'min-h-9' : 'h-9',
        )"
        :title="isRevealed ? 'Hide key' : 'Reveal key'"
        @click="revealKey"
      >
        <span :class="['min-w-0 flex-1 pr-2', isRevealed ? 'break-all whitespace-normal' : 'truncate whitespace-nowrap']">{{ displayKey }}</span>
        <UiIcon :name="isRevealed ? 'i-lucide-eye-off' : 'i-lucide-eye'" class="size-4 shrink-0 text-muted-foreground" />
      </button>

      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <UiButton variant="outline" size="icon-sm" class="h-8 w-8" title="Delete key" @click="deleteDialogOpen = true">
            <UiIcon name="i-lucide-trash-2" class="size-4 text-destructive" />
          </UiButton>
          <EditableApiKeyName :id="apiKey.id" :name="apiKey.name" :show-title="false" @updated="emit('changed')" />
        </div>
        <UiButton variant="outline" size="icon-sm" class="h-8 w-8" :disabled="isLoading" title="Copy key" @click="copyKey">
          <UiIcon :name="copied ? 'i-lucide-check' : 'i-lucide-copy'" :class="['size-4', copied ? 'text-green-500' : '']" />
        </UiButton>
      </div>
    </div>

    <UiDialog v-model:open="deleteDialogOpen" :ui="{ content: 'sm:max-w-[400px]' }">
      <template #content>
        <div class="space-y-1.5 pr-6">
          <h2 class="text-lg font-semibold leading-none tracking-tight">Delete API Key</h2>
          <p class="text-sm text-muted-foreground">Delete <strong class="font-semibold text-foreground">{{ apiKey.name ?? 'Unnamed key' }}</strong> &mdash; this cannot be undone.</p>
        </div>
        <p v-if="errorMessage" class="text-sm text-destructive">{{ errorMessage }}</p>
        <div class="flex justify-end gap-2">
          <UiButton variant="outline" size="sm" @click="deleteDialogOpen = false">Cancel</UiButton>
          <UiButton variant="destructive" size="sm" :disabled="isDeleting" @click="deleteKey">{{ isDeleting ? 'Deleting...' : 'Delete' }}</UiButton>
        </div>
      </template>
    </UiDialog>
  </div>
</template>
