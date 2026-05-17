<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    id: string;
    name: string | null;
    keyPreview?: string;
    showTitle?: boolean;
    showEditButton?: boolean;
    readonly?: boolean;
  }>(),
  {
    showTitle: true,
    showEditButton: true,
    keyPreview: "",
  }
);

const emit = defineEmits<{
  updated: [value: { name: string | null; keyPreview?: string }];
}>();

const dashboardApi = useDashboardApi();
const API_KEY_MIN_LENGTH = 3;
const API_KEY_MAX_LENGTH = 100;
const API_KEY_ALLOWED_PATTERN = /^[A-Za-z0-9_-]+$/;
const editDialogOpen = ref(false);
const newName = ref(props.name ?? "");
const apiKeyValue = ref("");
const revealedApiKey = ref<string | null>(null);
const isApiKeyDirty = ref(false);
const isUpdating = ref(false);
const isRevealingApiKey = ref(false);
const errorMessage = ref("");
const displayName = computed(() => props.name || "—");
const maskedApiKey = computed(() => props.keyPreview || "********");
const normalizedApiKeyValue = computed(() => apiKeyValue.value.trim());
const saveCostsPoints = computed(() => isApiKeyDirty.value && normalizedApiKeyValue.value !== revealedApiKey.value);
const apiKeyValidationError = computed(() => {
  if (!saveCostsPoints.value) return "";
  if (normalizedApiKeyValue.value.length < API_KEY_MIN_LENGTH) return `API key must be at least ${API_KEY_MIN_LENGTH} characters`;
  if (normalizedApiKeyValue.value.length > API_KEY_MAX_LENGTH) return `API key must be at most ${API_KEY_MAX_LENGTH} characters`;
  if (!API_KEY_ALLOWED_PATTERN.test(normalizedApiKeyValue.value)) return "API key can only contain letters, numbers, hyphen, and underscore";
  return "";
});

watch(editDialogOpen, (open) => {
  if (open) {
    newName.value = props.name ?? "";
    apiKeyValue.value = maskedApiKey.value;
    revealedApiKey.value = null;
    isApiKeyDirty.value = false;
    errorMessage.value = "";
  }
});

async function revealApiKeyForEdit() {
  if (props.readonly || revealedApiKey.value || isRevealingApiKey.value) return;
  isRevealingApiKey.value = true;
  errorMessage.value = "";
  try {
    const result = await dashboardApi.apiKeys.reveal({ id: props.id });
    if (!result.success) throw new Error(result.error);
    revealedApiKey.value = result.data.key;
    apiKeyValue.value = result.data.key;
    isApiKeyDirty.value = false;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Failed to reveal API key";
  } finally {
    isRevealingApiKey.value = false;
  }
}

function markApiKeyDirty() {
  if (!revealedApiKey.value) return;
  isApiKeyDirty.value = true;
}

async function updateName() {
  if (props.readonly) return;
  if (apiKeyValidationError.value) return;
  isUpdating.value = true;
  errorMessage.value = "";
  try {
    const result = await dashboardApi.apiKeys.updateName({ id: props.id, name: newName.value, ...(saveCostsPoints.value ? { key: normalizedApiKeyValue.value } : {}) });
    if (!result.success) throw new Error(result.error);
    editDialogOpen.value = false;
    emit("updated", { name: result.data.name, keyPreview: result.data.keyPreview });
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Failed to update API key";
  } finally {
    isUpdating.value = false;
  }
}
</script>

<template>
  <div class="flex min-w-0 items-center gap-1.5">
    <span v-if="showTitle" class="min-w-0 truncate text-lg font-semibold">{{ displayName }}</span>
    <UiTooltip v-if="showEditButton" text="Edit">
      <UiButton variant="outline" size="icon-sm" class="h-8 w-8" :disabled="readonly" @click="editDialogOpen = true">
        <UiIcon name="i-lucide-pencil" class="size-4" />
      </UiButton>
    </UiTooltip>
  </div>

  <UiDialog v-model:open="editDialogOpen" :ui="{ content: 'sm:max-w-md' }">
    <template #content>
      <div v-if="errorMessage" class="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {{ errorMessage }}
      </div>
      <label class="grid gap-1 text-sm font-medium"><span>Name <span class="text-destructive">*</span></span><input v-model="newName" class="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" placeholder="My API Key" @keydown.enter.prevent="updateName"></label>
      <label class="grid gap-1 text-sm font-medium">
        <span>API Key</span>
        <div class="relative">
          <input
            v-model="apiKeyValue"
            :class="[
              'h-9 w-full rounded-md border bg-background px-3 pr-9 font-mono text-sm outline-none focus-visible:ring-[3px]',
              apiKeyValidationError ? 'border-destructive focus-visible:border-destructive focus-visible:ring-destructive/20' : 'border-input focus-visible:border-ring focus-visible:ring-ring/50',
            ]"
            :readonly="!revealedApiKey || isRevealingApiKey"
            @focus="revealApiKeyForEdit"
            @click="revealApiKeyForEdit"
            @input="markApiKeyDirty"
            @keydown.enter.prevent="updateName"
          >
          <UiIcon v-if="isRevealingApiKey" name="i-lucide-loader-2" class="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        </div>
        <span v-if="apiKeyValidationError" class="text-xs font-normal text-destructive">{{ apiKeyValidationError }}</span>
      </label>
      <div class="flex justify-end gap-2">
        <UiButton variant="outline" @click="editDialogOpen = false">Cancel</UiButton>
        <UiButton class="w-24 transition-colors" :disabled="isUpdating || isRevealingApiKey || Boolean(apiKeyValidationError)" @click="updateName">
          <template v-if="isUpdating">Saving...</template>
          <template v-else-if="saveCostsPoints">
            <PointCoinIcon reverse class="size-5 shrink-0 text-foreground/85 drop-shadow-[0_0_0.35rem_rgba(255,255,255,0.18)]" />
            100
          </template>
          <template v-else>Save</template>
        </UiButton>
      </div>
    </template>
  </UiDialog>
</template>
