<script setup lang="ts">
import { cn } from "../../lib/utils";

const props = withDefaults(
  defineProps<{
    triggerClass?: string;
  }>(),
  {
    triggerClass: "",
  }
);

const emit = defineEmits<{
  created: [];
}>();

const dashboardApi = useDashboardApi();
const open = ref(false);
const name = ref("");
const isCreating = ref(false);
const createdKey = ref<string | null>(null);
const hasCreatedKey = ref(false);
const copied = ref(false);
const errorMessage = ref("");
const createButtonLabel = computed(() => (name.value.trim() ? "Create" : "Skip"));

function reset() {
  name.value = "";
  createdKey.value = null;
  hasCreatedKey.value = false;
  copied.value = false;
  errorMessage.value = "";
}

watch(open, (value) => {
  if (!value) {
    if (hasCreatedKey.value) emit("created");
    reset();
  }
});

async function createKey() {
  isCreating.value = true;
  errorMessage.value = "";
  try {
    const result = await dashboardApi.apiKeys.create({ name: name.value.trim() || undefined });
    if (!result.success) throw new Error(result.error);
    createdKey.value = result.data.key;
    hasCreatedKey.value = true;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Failed to create API key";
  } finally {
    isCreating.value = false;
  }
}

async function copyCreatedKey() {
  if (!createdKey.value) return;
  await navigator.clipboard.writeText(createdKey.value);
  copied.value = true;
  setTimeout(() => (copied.value = false), 2000);
}

function closeDialog() {
  open.value = false;
}
</script>

<template>
  <UiButton variant="outline" :class="cn('gap-2', props.triggerClass)" @click="open = true">
    <UiIcon name="i-lucide-plus" class="size-4" />
    Create API Key
  </UiButton>

  <UiDialog v-model:open="open" :prevent-outside-close="isCreating" :prevent-escape-close="isCreating" :ui="{ content: 'max-h-[calc(100dvh-1rem)] p-4 sm:max-w-md sm:p-6' }">
    <template #content>
      <template v-if="createdKey">
        <div class="space-y-1.5 pr-6">
          <h2 class="text-lg font-semibold leading-none tracking-tight">API Key Created</h2>
          <p class="sr-only">Your new API key is ready to use.</p>
        </div>
        <div class="space-y-4 py-1">
          <div class="rounded-md border border-border bg-muted/30 p-3">
            <p class="text-xs text-muted-foreground">Your API Key</p>
            <div class="mt-2 flex items-center gap-2">
              <code class="flex-1 break-all rounded bg-background px-2 py-1 font-mono text-xs font-medium">{{ createdKey }}</code>
              <UiButton type="button" variant="outline" size="sm" class="h-8 shrink-0 px-2" :title="copied ? 'Copied!' : 'Copy key'" @click="copyCreatedKey">
                <UiIcon :name="copied ? 'i-lucide-check' : 'i-lucide-copy'" class="size-3.5" />
                {{ copied ? 'Copied' : 'Copy' }}
              </UiButton>
            </div>
          </div>

          <div class="flex justify-end">
            <UiButton type="button" size="sm" @click="closeDialog">Done</UiButton>
          </div>
        </div>
      </template>

      <template v-else>
        <div class="space-y-1.5 pr-6">
          <h2 class="text-lg font-semibold leading-none tracking-tight">Create API Key</h2>
          <p class="sr-only">Create a new API key for accessing Opendum.</p>
        </div>

        <form class="space-y-4 py-1" autocomplete="off" @submit.prevent="createKey">
          <div v-if="errorMessage" class="relative w-full rounded-lg border border-destructive/50 px-4 py-3 text-sm text-destructive">
            <UiIcon name="i-lucide-alert-circle" class="absolute left-4 top-4 size-4" />
            <div class="pl-7 text-xs">{{ errorMessage }}</div>
          </div>

          <div class="space-y-2">
            <label for="api-key-name" class="text-sm font-medium">Name</label>
            <input
              id="api-key-name"
              v-model="name"
              type="text"
              :disabled="isCreating"
              class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
              placeholder="My API Key"
            >
          </div>

          <div class="flex justify-end gap-2">
            <UiButton type="button" variant="outline" size="sm" :disabled="isCreating" @click="open = false">Cancel</UiButton>
            <UiButton type="submit" size="sm" :disabled="isCreating">
              <UiIcon v-if="isCreating" name="i-lucide-loader-2" class="size-3.5 animate-spin" />
              {{ isCreating ? 'Creating...' : createButtonLabel }}
            </UiButton>
          </div>
        </form>
      </template>
    </template>
  </UiDialog>
</template>
