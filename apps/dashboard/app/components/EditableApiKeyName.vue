<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    id: string;
    name: string | null;
    showTitle?: boolean;
    showEditButton?: boolean;
  }>(),
  {
    showTitle: true,
    showEditButton: true,
  }
);

const emit = defineEmits<{
  updated: [];
}>();

const dashboardApi = useDashboardApi();
const editDialogOpen = ref(false);
const newName = ref(props.name ?? "");
const isUpdating = ref(false);
const errorMessage = ref("");

watch(editDialogOpen, (open) => {
  if (open) {
    newName.value = props.name ?? "";
    errorMessage.value = "";
  }
});

async function updateName() {
  isUpdating.value = true;
  errorMessage.value = "";
  try {
    const result = await dashboardApi.apiKeys.updateName({ id: props.id, name: newName.value });
    if (!result.success) throw new Error(result.error);
    editDialogOpen.value = false;
    emit("updated");
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Failed to update API key name";
  } finally {
    isUpdating.value = false;
  }
}
</script>

<template>
  <div class="flex min-w-0 items-center gap-1.5">
    <span v-if="showTitle" class="min-w-0 truncate text-lg font-semibold">{{ name ?? 'Unnamed key' }}</span>
    <UiButton v-if="showEditButton" variant="outline" size="icon-sm" class="h-8 w-8" title="Edit name" @click="editDialogOpen = true">
      <UiIcon name="i-lucide-pencil" class="size-4" />
    </UiButton>
  </div>

  <UiDialog v-model:open="editDialogOpen" :ui="{ content: 'sm:max-w-[400px]' }">
    <template #content>
      <div v-if="errorMessage" class="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {{ errorMessage }}
      </div>
      <div class="py-3">
        <label class="grid gap-1.5 text-sm font-medium">
          Name
          <input
            v-model="newName"
            class="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            placeholder="My API Key"
            @keydown.enter.prevent="updateName"
          >
        </label>
      </div>
      <div class="flex justify-end gap-2">
        <UiButton variant="outline" size="sm" @click="editDialogOpen = false">Cancel</UiButton>
        <UiButton size="sm" :disabled="isUpdating" @click="updateName">{{ isUpdating ? 'Saving...' : 'Save' }}</UiButton>
      </div>
    </template>
  </UiDialog>
</template>
