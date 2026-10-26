<script setup lang="ts">
import { errorText, settle } from "~~/lib/settle";
import { compareIds } from "@opendum/models/sort";

import type { AccessMode } from "~~/lib/access-draft";

const props = defineProps<{
  apiKeyId: string;
  availableModels: string[];
  initialMode: AccessMode;
  initialModels: string[];
  readonly?: boolean;
}>();

const emit = defineEmits<{
  updated: [value: { mode: AccessMode; models: string[] }];
}>();

const api = useApi();
const mode = ref<AccessMode>(props.initialMode);
const models = ref<string[]>(props.initialModels);
const search = ref("");
const pickerOpen = ref(false);
const isSaving = ref(false);
const error = ref("");
const saved = ref<{ mode: AccessMode; ids: string[] }>({
  mode: props.initialMode,
  ids: props.initialModels,
});

const targets = computed(() =>
  props.availableModels.map((model) => ({ id: model, label: model, mono: true }))
);

async function save(value: { mode: AccessMode; ids: string[] }) {
  isSaving.value = true;
  error.value = "";
  const updated = await settle(() => api.apiKeys.updateModelAccess({ id: props.apiKeyId, mode: value.mode, models: value.ids }));
  isSaving.value = false;
  if (!updated.ok) {
    error.value = errorText(updated.error, "Failed to update model access");
    return;
  }
  if (!updated.value.success) {
    error.value = updated.value.error;
    return;
  }
  const result = updated.value;
    saved.value = { mode: result.data.mode, ids: result.data.models };
    mode.value = result.data.mode;
    models.value = [...result.data.models];
    emit("updated", { mode: result.data.mode, models: result.data.models });
}
</script>

<template>
  <ApiKeyAccessPicker
    v-model:mode="mode"
    v-model:ids="models"
    v-model:search="search"
    v-model:picker-open="pickerOpen"
    v-model:saving="isSaving"
    v-model:error="error"
    v-model:saved="saved"
    title="Models"
    noun="model"
    :targets="targets"
    :search-text="(target) => target.label"
    :initial-mode="initialMode"
    :initial-ids="initialModels"
    :readonly="readonly"
    :normalize="(ids) => Array.from(new Set(ids)).sort(compareIds)"
    @save="save"
  />
</template>
