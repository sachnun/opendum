<script setup lang="ts">
import { labelOf } from "@opendum/providers/provider-accounts";

import type { AccessMode } from "~~/lib/access-draft";

interface ProviderAccountOption {
  id: string;
  provider: string;
  name: string;
  email: string | null;
}

const props = defineProps<{
  apiKeyId: string;
  availableAccounts: ProviderAccountOption[];
  initialMode: AccessMode;
  initialAccounts: string[];
  readonly?: boolean;
}>();

const emit = defineEmits<{
  updated: [value: { mode: AccessMode; accounts: string[] }];
}>();

const api = useApi();
const mode = ref<AccessMode>(props.initialMode);
const accounts = ref<string[]>(props.initialAccounts);
const search = ref("");
const pickerOpen = ref(false);
const isSaving = ref(false);
const error = ref("");
const saved = ref<{ mode: AccessMode; ids: string[] }>({
  mode: props.initialMode,
  ids: props.initialAccounts,
});

const targets = computed(() =>
  props.availableAccounts.map((account) => ({
    id: account.id,
    label: account.email ? `${account.name} (${account.email})` : account.name,
    detail: `${labelOf(account.provider)}${account.email ? ` - ${account.email}` : ""}`,
  }))
);

function searchText(target: { id: string }): string {
  const account = props.availableAccounts.find((entry) => entry.id === target.id);
  return account ? `${account.provider} ${account.name} ${account.email ?? ""}` : target.id;
}

async function save(value: { mode: AccessMode; ids: string[] }) {
  isSaving.value = true;
  error.value = "";
  try {
    const result = await api.apiKeys.updateAccountAccess({ id: props.apiKeyId, mode: value.mode, accounts: value.ids });
    if (!result.success) throw new Error(result.error);
    saved.value = { mode: result.data.mode, ids: result.data.accounts };
    mode.value = result.data.mode;
    accounts.value = [...result.data.accounts];
    emit("updated", { mode: result.data.mode, accounts: result.data.accounts });
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : "Failed to update account access";
  } finally {
    isSaving.value = false;
  }
}
</script>

<template>
  <ApiKeyAccessPicker
    v-model:mode="mode"
    v-model:ids="accounts"
    v-model:search="search"
    v-model:picker-open="pickerOpen"
    v-model:saving="isSaving"
    v-model:error="error"
    v-model:saved="saved"
    title="Accounts"
    noun="account"
    :targets="targets"
    :search-text="searchText"
    :initial-mode="initialMode"
    :initial-ids="initialAccounts"
    :readonly="readonly"
    :normalize="(ids) => Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b))"
    @save="save"
  />
</template>
