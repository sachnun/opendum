<script setup lang="ts">
const emit = defineEmits<{
  created: [];
}>();

const dashboardApi = useDashboardApi();
const open = ref(false);
const name = ref("");
const isCreating = ref(false);
const createdKey = ref<string | null>(null);
const copied = ref(false);
const errorMessage = ref("");

function reset() {
  name.value = "";
  createdKey.value = null;
  copied.value = false;
  errorMessage.value = "";
}

watch(open, (value) => {
  if (!value) {
    reset();
    emit("created");
  }
});

async function createKey() {
  isCreating.value = true;
  errorMessage.value = "";
  try {
    const result = await dashboardApi.apiKeys.create({ name: name.value.trim() || undefined });
    if (!result.success) throw new Error(result.error);
    createdKey.value = result.data.key;
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
  <UiButton size="sm" @click="open = true">
    <UiIcon name="i-lucide-plus" class="mr-1.5 size-3.5" />
    Create API Key
  </UiButton>

  <UiDialog v-model:open="open" :ui="{ content: 'sm:max-w-[440px]' }">
    <template #content>
      <template v-if="createdKey">
        <div class="space-y-1.5 pr-6">
          <h2 class="text-lg font-semibold leading-none tracking-tight">API Key Created</h2>
          <p class="sr-only">Your new API key is ready to use.</p>
        </div>
        <div class="py-3">
          <label class="text-sm font-medium">Your API Key</label>
          <div class="mt-1.5 flex items-center gap-2">
            <code class="flex-1 break-all rounded bg-muted px-2.5 py-1.5 font-mono text-xs">{{ createdKey }}</code>
            <UiButton variant="outline" size="sm" class="h-8 w-8 shrink-0 p-0" title="Copy key" @click="copyCreatedKey">
              <UiIcon :name="copied ? 'i-lucide-check' : 'i-lucide-copy'" :class="['size-3.5', copied ? 'text-green-500' : '']" />
            </UiButton>
          </div>
        </div>
        <div class="flex justify-end">
          <UiButton size="sm" @click="closeDialog">Done</UiButton>
        </div>
      </template>

      <template v-else>
        <div class="space-y-1.5 pr-6">
          <h2 class="text-lg font-semibold leading-none tracking-tight">Create API Key</h2>
          <p class="sr-only">Create a new API key for accessing Opendum.</p>
        </div>
        <div v-if="errorMessage" class="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {{ errorMessage }}
        </div>
        <div class="space-y-3 py-3">
          <label class="grid gap-1.5 text-sm font-medium">
            Name
            <input
              v-model="name"
              class="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              placeholder="My API Key"
              @keydown.enter.prevent="createKey"
            >
          </label>
        </div>
        <div class="flex justify-end gap-2">
          <UiButton variant="outline" size="sm" @click="open = false">Cancel</UiButton>
          <UiButton size="sm" :disabled="isCreating" @click="createKey">{{ isCreating ? 'Creating...' : 'Create' }}</UiButton>
        </div>
      </template>
    </template>
  </UiDialog>
</template>
