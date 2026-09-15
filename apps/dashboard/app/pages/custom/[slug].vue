<script setup lang="ts">
import type {
  ActionResult,
  CustomProviderListItem,
  CustomProviderModelFlags,
  CustomProviderModelMeta,
  CustomProviderModelRow,
} from "../../../lib/api-types";

definePageMeta({ middleware: "auth", layout: "dashboard" });

interface HeaderRow {
  key: string;
  value: string;
}

interface ProviderForm {
  name: string;
  baseUrl: string;
  headers: HeaderRow[];
  enabled: boolean;
}

interface ModelForm {
  modelId: string;
  upstream: string;
  authless: boolean;
  reasoning: boolean;
  toolCall: boolean;
  vision: boolean;
  responsesApi: boolean;
  topPDeprecated: boolean;
  convertExternalImages: boolean;
}

const inputClass = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50";
const labelClass = "text-xs font-medium text-muted-foreground";

const route = useRoute();
const dashboardApi = useApi();
const slug = computed(() => String(route.params.slug));

const { data, error, pending, refresh } = useCachedData(
  dataKeys.customProviders,
  () => dashboardApi.customProviders.list(),
);

const provider = computed<CustomProviderListItem | null>(
  () => (data.value ?? []).find((row) => row.slug === slug.value) ?? null,
);
const notFound = computed(() => !pending.value && data.value !== undefined && !provider.value);

const editOpen = ref(false);
const modelOpen = ref(false);
const connectOpen = ref(false);
const deleteOpen = ref(false);
const deleteModelTarget = ref<CustomProviderModelRow | null>(null);
const busyAction = ref("");
const actionError = ref("");
const actionNotice = ref("");

const editForm = ref<ProviderForm | null>(null);
const modelForm = ref<ModelForm>(emptyModelForm());
const connectToken = ref("");
const connectName = ref("");

function emptyModelForm(): ModelForm {
  return { modelId: "", upstream: "", authless: false, reasoning: true, toolCall: true, vision: true, responsesApi: false, topPDeprecated: false, convertExternalImages: false };
}

function modelFormFrom(model: CustomProviderModelRow): ModelForm {
  return {
    modelId: model.modelId,
    upstream: model.upstream ?? "",
    authless: model.authless,
    reasoning: model.meta?.reasoning ?? true,
    toolCall: model.meta?.toolCall ?? true,
    vision: model.meta?.vision ?? true,
    responsesApi: model.customFlags?.responses_api ?? false,
    topPDeprecated: model.customFlags?.top_p_deprecated ?? false,
    convertExternalImages: model.customFlags?.convert_external_images ?? false,
  };
}

function runAction<T>(action: () => Promise<ActionResult<T>>, key: string, onSuccess?: (result: Extract<ActionResult<T>, { success: true }>) => void) {
  busyAction.value = key;
  actionError.value = "";
  actionNotice.value = "";
  return action()
    .then((result) => {
      if (!result.success) {
        actionError.value = result.error;
        return;
      }
      if (onSuccess && "data" in result) onSuccess(result as Extract<ActionResult<T>, { success: true }>);
      void refresh();
    })
    .catch(() => {
      actionError.value = "Request failed. Please try again.";
    })
    .finally(() => {
      busyAction.value = "";
    });
}

function headersPayload(form: { headers: HeaderRow[] }): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const row of form.headers) {
    const key = row.key.trim();
    const value = row.value.trim();
    if (key && value) headers[key] = value;
  }
  return headers;
}

function openEdit() {
  const row = provider.value;
  if (!row) return;
  editForm.value = {
    name: row.name,
    baseUrl: row.baseUrl,
    headers: Object.entries(row.extraHeaders ?? {}).map(([key, value]) => ({ key, value })),
    enabled: row.enabled,
  };
  actionError.value = "";
  actionNotice.value = "";
  editOpen.value = true;
}

function submitEdit() {
  const form = editForm.value;
  if (!form) return;
  void runAction(() => dashboardApi.customProviders.update({
    slug: slug.value,
    name: form.name.trim() || undefined,
    baseUrl: form.baseUrl.trim() || undefined,
    extraHeaders: headersPayload(form),
    enabled: form.enabled,
  }), "update", () => {
    editOpen.value = false;
    actionNotice.value = "Settings saved.";
  });
}

function toggleEnabled(enabled: boolean) {
  const row = provider.value;
  if (!row) return;
  row.enabled = enabled;
  void runAction(() => dashboardApi.customProviders.update({ slug: row.slug, enabled }), "toggle");
}

function openModelAdd() {
  modelForm.value = emptyModelForm();
  actionError.value = "";
  actionNotice.value = "";
  modelOpen.value = true;
}

function openModelEdit(model: CustomProviderModelRow) {
  modelForm.value = modelFormFrom(model);
  actionError.value = "";
  actionNotice.value = "";
  modelOpen.value = true;
}

function metaPayload(form: ModelForm): CustomProviderModelMeta {
  return { reasoning: form.reasoning, toolCall: form.toolCall, vision: form.vision };
}

function flagsPayload(form: ModelForm): CustomProviderModelFlags {
  return { responses_api: form.responsesApi, top_p_deprecated: form.topPDeprecated, convert_external_images: form.convertExternalImages };
}

function submitModel() {
  const form = modelForm.value;
  const modelId = form.modelId.trim();
  if (!modelId) return;
  void runAction(() => dashboardApi.customProviders.addModels({
    slug: slug.value,
    models: [{
      modelId,
      upstream: form.upstream.trim() || undefined,
      authless: form.authless,
      meta: metaPayload(form),
      customFlags: flagsPayload(form),
    }],
  }), "model-save", () => {
    modelOpen.value = false;
    actionNotice.value = `Model "${modelId}" saved.`;
  });
}

function submitDeleteModel() {
  const target = deleteModelTarget.value;
  if (!target) return;
  void runAction(() => dashboardApi.customProviders.deleteModel({ slug: slug.value, modelId: target.modelId }), "model-delete", () => {
    deleteModelTarget.value = null;
    deleteOpen.value = false;
    actionNotice.value = `Model "${target.modelId}" removed.`;
  });
}

function submitSync() {
  void runAction(() => dashboardApi.customProviders.syncModels({ slug: slug.value }), "sync", (result) => {
    actionNotice.value = `Refreshed: ${result.data.discovered} found, ${result.data.added} added.`;
  });
}

function openConnect() {
  connectToken.value = "";
  connectName.value = "";
  actionError.value = "";
  actionNotice.value = "";
  connectOpen.value = true;
}

function submitConnect() {
  void runAction(() => dashboardApi.customProviders.connect({
    slug: slug.value,
    token: connectToken.value.trim(),
    name: connectName.value.trim() || undefined,
  }), "connect", (result) => {
    connectOpen.value = false;
    actionNotice.value = `API key ${result.data.isUpdate ? "updated" : "connected"}.`;
  });
}

function submitDelete() {
  void runAction(() => dashboardApi.customProviders.remove({ slug: slug.value }), "delete", () => {
    void navigateTo("/");
  });
}

function modelFlagLabel(model: CustomProviderModelRow): string {
  const parts: string[] = [];
  if (model.meta?.reasoning) parts.push("reasoning");
  if (model.meta?.toolCall) parts.push("tools");
  if (model.meta?.vision) parts.push("vision");
  if (model.customFlags?.responses_api) parts.push("responses");
  return parts.join(" · ") || "—";
}
</script>

<template>
  <div class="space-y-6">
    <div class="dashboard-header-divider">
      <div class="flex min-h-9 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 class="inline-flex min-h-9 flex-wrap items-center gap-2 text-xl font-semibold">
          <NuxtLink to="/" class="text-muted-foreground transition-colors hover:text-foreground" aria-label="Back to providers">
            <UiIcon name="i-lucide-arrow-left" class="size-5" />
          </NuxtLink>
          {{ provider?.name ?? slug }}
          <UiBadge variant="outline" class="text-xs font-mono">{{ slug }}</UiBadge>
        </h2>
        <div class="flex items-center gap-2">
          <UiSwitch v-if="provider" :model-value="provider.enabled" :disabled="busyAction === 'toggle'" @update:model-value="toggleEnabled" />
          <UiButton size="sm" :disabled="!provider" @click="openConnect">
            Connect key
          </UiButton>
        </div>
      </div>
    </div>

    <div v-if="pending && !data" class="h-40 animate-pulse rounded-xl border border-border bg-card" />

    <div v-else-if="notFound" class="rounded-xl border border-dashed border-border p-10 text-center">
      <p class="text-sm font-medium text-foreground">Provider not found</p>
      <p class="mt-1 text-sm text-muted-foreground">This custom provider doesn't exist or was removed.</p>
      <UiButton variant="outline" class="mt-4" @click="navigateTo('/')">Back to providers</UiButton>
    </div>

    <template v-else-if="provider">
      <div v-if="actionError" class="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {{ actionError }}
      </div>
      <div v-if="actionNotice" class="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
        {{ actionNotice }}
      </div>

      <DataNotice :error="error" />

      <UiCard class="gap-3 p-5">
        <div class="flex items-center justify-between gap-3">
          <UiCardTitle class="text-sm text-muted-foreground">Settings</UiCardTitle>
          <UiButton size="sm" variant="outline" @click="openEdit">
            Edit
          </UiButton>
        </div>
        <div class="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-baseline">
          <span :class="labelClass">Base URL</span>
          <span class="truncate font-mono text-xs">{{ provider.baseUrl }}</span>
          <span :class="labelClass">Headers</span>
          <div v-if="provider.extraHeaders && Object.keys(provider.extraHeaders).length > 0" class="flex flex-wrap gap-2">
            <UiBadge v-for="(value, key) in provider.extraHeaders" :key="key" variant="secondary" class="font-mono text-xs font-normal">
              {{ key }}: {{ value }}
            </UiBadge>
          </div>
          <span v-else class="text-xs text-muted-foreground">None</span>
        </div>
      </UiCard>

      <UiCard class="gap-3 p-5">
        <div class="flex items-center justify-between gap-3">
          <UiCardTitle class="text-sm text-muted-foreground">Models ({{ provider.models.length }})</UiCardTitle>
          <div class="flex items-center gap-2">
            <UiButton size="icon-sm" variant="outline" :title="`Refresh models from ${provider.baseUrl}`" :disabled="busyAction === 'sync'" @click="submitSync">
              <UiIcon name="i-lucide-refresh-cw" :class="['size-4', busyAction === 'sync' ? 'animate-spin' : '']" />
            </UiButton>
            <UiButton size="sm" variant="outline" @click="openModelAdd">
              Add model
            </UiButton>
          </div>
        </div>
        <div class="overflow-x-auto rounded-lg border border-border">
          <table class="w-full text-left text-sm">
            <thead class="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th class="px-3 py-2 font-medium">Model ID</th>
                <th class="px-3 py-2 font-medium">Upstream</th>
                <th class="px-3 py-2 font-medium">Capabilities</th>
                <th class="px-3 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="provider.models.length === 0">
                <td colspan="4" class="px-3 py-4 text-center text-muted-foreground">
                  No models yet — add manually or refresh from the upstream.
                </td>
              </tr>
              <template v-else>
                <tr v-for="model in provider.models" :key="model.id" class="border-t border-border">
                  <td class="px-3 py-2 font-mono text-xs">{{ model.modelId }}</td>
                  <td class="px-3 py-2 font-mono text-xs text-muted-foreground">{{ model.upstream }}</td>
                  <td class="px-3 py-2 text-xs">{{ modelFlagLabel(model) }}</td>
                  <td class="px-3 py-2">
                    <div class="flex justify-end gap-2">
                      <UiButton size="xs" variant="ghost" @click="openModelEdit(model)">
                        Edit
                      </UiButton>
                      <UiButton size="xs" variant="ghost" class="text-destructive" @click="deleteModelTarget = model; deleteOpen = true">
                        Remove
                      </UiButton>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </UiCard>

      <UiCard class="flex-row items-center justify-between gap-3 p-5">
        <div>
          <p class="text-sm font-medium text-foreground">Delete provider</p>
          <p class="text-xs text-muted-foreground">Removes the provider, its models, and its accounts.</p>
        </div>
        <UiButton variant="destructive" size="sm" @click="deleteModelTarget = null; deleteOpen = true">
          Delete
        </UiButton>
      </UiCard>
    </template>

    <UiDialog v-model:open="editOpen" ui.content="sm:max-w-xl">
      <h3 class="text-lg font-semibold">Settings</h3>
      <div v-if="editForm" class="grid gap-4">
        <label class="grid gap-1.5">
          <span :class="labelClass">Name</span>
          <input v-model="editForm.name" :class="inputClass">
        </label>
        <label class="grid gap-1.5">
          <span :class="labelClass">Base URL</span>
          <input v-model="editForm.baseUrl" :class="inputClass" class="font-mono">
        </label>
        <div class="grid gap-1.5">
          <div class="flex items-center justify-between">
            <span :class="labelClass">Headers</span>
            <UiButton size="xs" variant="outline" @click="editForm.headers.push({ key: '', value: '' })">
              Add
            </UiButton>
          </div>
          <div v-for="(header, index) in editForm.headers" :key="index" class="flex items-center gap-2">
            <input v-model="header.key" :class="inputClass" class="w-2/5" placeholder="Header">
            <input v-model="header.value" :class="inputClass" class="flex-1" placeholder="Value">
            <UiButton size="icon-sm" variant="ghost" @click="editForm.headers.splice(index, 1)">
              ✕
            </UiButton>
          </div>
        </div>
        <label class="flex items-center justify-between">
          <span :class="labelClass">Enabled</span>
          <UiSwitch v-model="editForm.enabled" />
        </label>
      </div>
      <div class="flex justify-end gap-2">
        <UiButton variant="outline" @click="editOpen = false">
          Cancel
        </UiButton>
        <UiButton :disabled="busyAction === 'update'" @click="submitEdit">
          {{ busyAction === "update" ? "Saving…" : "Save" }}
        </UiButton>
      </div>
    </UiDialog>

    <UiDialog v-model:open="modelOpen" ui.content="sm:max-w-xl">
      <h3 class="text-lg font-semibold">{{ modelForm.modelId ? `Edit ${modelForm.modelId}` : "Add model" }}</h3>
      <div class="grid gap-4">
        <label class="grid gap-1.5">
          <span :class="labelClass">Model ID (public)</span>
          <input v-model="modelForm.modelId" :class="inputClass" class="font-mono" placeholder="qwen3-32b">
        </label>
        <label class="grid gap-1.5">
          <span :class="labelClass">Upstream</span>
          <input v-model="modelForm.upstream" :class="inputClass" class="font-mono" placeholder="Qwen/Qwen3-32B">
        </label>
        <div class="grid grid-cols-2 gap-3">
          <label v-for="flag in (['reasoning', 'toolCall', 'vision', 'authless'] as const)" :key="flag" class="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <span class="text-sm">{{ flag }}</span>
            <UiSwitch v-model="modelForm[flag]" size="sm" />
          </label>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <label class="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <span class="text-sm">responses_api</span>
            <UiSwitch v-model="modelForm.responsesApi" size="sm" />
          </label>
          <label class="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <span class="text-sm">top_p_deprecated</span>
            <UiSwitch v-model="modelForm.topPDeprecated" size="sm" />
          </label>
          <label class="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <span class="text-sm">convert images</span>
            <UiSwitch v-model="modelForm.convertExternalImages" size="sm" />
          </label>
        </div>
      </div>
      <div class="flex justify-end gap-2">
        <UiButton variant="outline" @click="modelOpen = false">
          Cancel
        </UiButton>
        <UiButton :disabled="busyAction === 'model-save' || !modelForm.modelId.trim()" @click="submitModel">
          {{ busyAction === "model-save" ? "Saving…" : "Save" }}
        </UiButton>
      </div>
    </UiDialog>

    <UiDialog v-model:open="connectOpen" ui.content="sm:max-w-lg">
      <h3 class="text-lg font-semibold">Connect API key</h3>
      <div class="grid gap-4">
        <label class="grid gap-1.5">
          <span :class="labelClass">Name (optional)</span>
          <input v-model="connectName" :class="inputClass" placeholder="prod key">
        </label>
        <label class="grid gap-1.5">
          <span :class="labelClass">API key</span>
          <input v-model="connectToken" type="password" :class="inputClass" class="font-mono" placeholder="sk-...">
        </label>
      </div>
      <div class="flex justify-end gap-2">
        <UiButton variant="outline" @click="connectOpen = false">
          Cancel
        </UiButton>
        <UiButton :disabled="busyAction === 'connect' || !connectToken.trim()" @click="submitConnect">
          {{ busyAction === "connect" ? "Validating…" : "Validate & connect" }}
        </UiButton>
      </div>
    </UiDialog>

    <UiDialog v-model:open="deleteOpen" ui.content="sm:max-w-md">
      <h3 class="text-lg font-semibold">
        {{ deleteModelTarget ? "Remove model?" : `Delete ${slug}?` }}
      </h3>
      <p class="text-sm text-muted-foreground">
        {{ deleteModelTarget ? `"${deleteModelTarget.modelId}" will be removed from this provider.` : "The provider, its models, and its accounts will be removed. This cannot be undone." }}
      </p>
      <div class="flex justify-end gap-2">
        <UiButton variant="outline" @click="deleteOpen = false; deleteModelTarget = null">
          Cancel
        </UiButton>
        <UiButton variant="destructive" :disabled="busyAction === 'model-delete' || busyAction === 'delete'" @click="deleteModelTarget ? submitDeleteModel() : submitDelete()">
          {{ deleteModelTarget ? "Remove" : "Delete" }}
        </UiButton>
      </div>
    </UiDialog>
  </div>
</template>
