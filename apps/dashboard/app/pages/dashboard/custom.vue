<script setup lang="ts">
import type {
  ActionResult,
  CustomProviderListItem,
  CustomProviderModelFlags,
  CustomProviderModelMeta,
  CustomProviderModelRow,
} from "../../../lib/dashboard-api-types";

definePageMeta({ middleware: "auth", layout: "dashboard" });

interface HeaderRow {
  key: string;
  value: string;
}

interface ProviderForm {
  name: string;
  slug: string;
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
const labelClass = "text-sm font-medium";
const dashboardApi = useDashboardApi();

const { data, error, pending, refresh } = await useAsyncData("dashboard-custom-providers", () => dashboardApi.customProviders.list());

const providers = computed<CustomProviderListItem[]>(() => data.value ?? []);

const editOpen = ref(false);
const modelOpen = ref(false);
const connectOpen = ref(false);
const deleteOpen = ref(false);
const deleteModelOpen = ref(false);
const modelProvider = ref<CustomProviderListItem | null>(null);
const connectProvider = ref<CustomProviderListItem | null>(null);
const deleteProvider = ref<CustomProviderListItem | null>(null);
const deleteModelTarget = ref<{ provider: CustomProviderListItem; model: CustomProviderModelRow } | null>(null);
const busyAction = ref<string>("");
const actionError = ref<string>("");
const actionNotice = ref<string>("");

function providerFormFrom(row: CustomProviderListItem): ProviderForm {
  return {
    name: row.name,
    slug: row.slug,
    baseUrl: row.baseUrl,
    headers: Object.entries(row.extraHeaders ?? {}).map(([key, value]) => ({ key, value })),
    enabled: row.enabled,
  };
}

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

const editForm = ref<ProviderForm | null>(null);
const modelForm = ref<ModelForm>(emptyModelForm());
const connectToken = ref("");
const connectName = ref("");


const wizardOpen = ref(false);

function onWizardFinished(provider: CustomProviderListItem) {
  void refresh();
  actionNotice.value = `Custom provider "${provider.slug}" is ready. Find it under ${provider.slug}/<modelId>.`;
}

function openEdit(row: CustomProviderListItem) {
  editForm.value = providerFormFrom(row);
  actionError.value = "";
  actionNotice.value = "";
  editOpen.value = true;
}

function closeEdit() {
  editOpen.value = false;
  editForm.value = null;
}

function openModelAdd(row: CustomProviderListItem) {
  modelProvider.value = row;
  modelForm.value = emptyModelForm();
  actionError.value = "";
  actionNotice.value = "";
  modelOpen.value = true;
}

function openModelEdit(provider: CustomProviderListItem, model: CustomProviderModelRow) {
  modelProvider.value = provider;
  modelForm.value = modelFormFrom(model);
  actionError.value = "";
  actionNotice.value = "";
  modelOpen.value = true;
}

function closeModel() {
  modelOpen.value = false;
  modelProvider.value = null;
}

function openConnect(row: CustomProviderListItem) {
  connectProvider.value = row;
  connectToken.value = "";
  connectName.value = "";
  actionError.value = "";
  actionNotice.value = "";
  connectOpen.value = true;
}

function addHeaderRow(form: { headers: HeaderRow[] }) {
  form.headers.push({ key: "", value: "" });
}

function removeHeaderRow(form: { headers: HeaderRow[] }, index: number) {
  form.headers.splice(index, 1);
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
      if (onSuccess && "data" in result) {
        onSuccess(result as Extract<ActionResult<T>, { success: true }>);
      }
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

function metaPayload(form: ModelForm): CustomProviderModelMeta {
  return { reasoning: form.reasoning, toolCall: form.toolCall, vision: form.vision };
}

function flagsPayload(form: ModelForm): CustomProviderModelFlags {
  return { responses_api: form.responsesApi, top_p_deprecated: form.topPDeprecated, convert_external_images: form.convertExternalImages };
}

function submitEdit() {
  if (!editForm.value) return;
  const form = editForm.value;
  void runAction(() => dashboardApi.customProviders.update({
    slug: form.slug,
    name: form.name.trim() || undefined,
    baseUrl: form.baseUrl.trim() || undefined,
    extraHeaders: headersPayload(form),
    enabled: form.enabled,
  }), "update", () => {
    closeEdit();
    actionNotice.value = `Provider "${form.slug}" updated.`;
  });
}

function toggleEnabled(row: CustomProviderListItem, enabled: boolean) {
  row.enabled = enabled;
  void runAction(() => dashboardApi.customProviders.update({ slug: row.slug, enabled }), `toggle-${row.slug}`);
}

function submitDeleteProvider() {
  if (!deleteProvider.value) return;
  const slug = deleteProvider.value.slug;
  void runAction(() => dashboardApi.customProviders.remove({ slug }), "delete", () => {
    deleteProvider.value = null;
    deleteOpen.value = false;
    actionNotice.value = `Provider "${slug}" and its accounts were deleted.`;
  });
}

function submitModel() {
  if (!modelProvider.value) return;
  const slug = modelProvider.value.slug;
  const form = modelForm.value;
  void runAction(() => dashboardApi.customProviders.addModels({
    slug,
    models: [{
      modelId: form.modelId.trim(),
      upstream: form.upstream.trim() || undefined,
      authless: form.authless,
      meta: metaPayload(form),
      customFlags: flagsPayload(form),
    }],
  }), "model-save", () => {
    const modelId = form.modelId.trim();
    actionNotice.value = `Model "${modelId}" saved on "${slug}".`;
    closeModel();
  });
}

function submitDeleteModel() {
  const target = deleteModelTarget.value;
  if (!target) return;
  void runAction(() => dashboardApi.customProviders.deleteModel({ slug: target.provider.slug, modelId: target.model.modelId }), "model-delete", () => {
    actionNotice.value = `Model "${target.model.modelId}" removed from "${target.provider.slug}".`;
    deleteModelTarget.value = null;
    deleteModelOpen.value = false;
  });
}

function submitSync(row: CustomProviderListItem) {
  void runAction(() => dashboardApi.customProviders.syncModels({ slug: row.slug }), `sync-${row.slug}`, (result) => {
    actionNotice.value = `Synced "${row.slug}": ${result.data.discovered} model(s) found, ${result.data.added} added.`;
  });
}

function submitConnect() {
  if (!connectProvider.value) return;
  const slug = connectProvider.value.slug;
  void runAction(() => dashboardApi.customProviders.connect({ slug, token: connectToken.value.trim(), name: connectName.value.trim() || undefined }), "connect", (result) => {
    actionNotice.value = `API key ${result.data.isUpdate ? "updated" : "connected"} for "${slug}".`;
    connectProvider.value = null;
    connectOpen.value = false;
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
        <h2 class="inline-flex min-h-9 items-center gap-2 text-xl font-semibold">
          Custom Providers
        </h2>
        <UiButton @click="wizardOpen = true">
          ＋ Add custom provider
        </UiButton>
      </div>
    </div>

    <CustomProviderWizard v-model:open="wizardOpen" @finished="onWizardFinished" />

    <p class="text-sm text-muted-foreground">
      Register OpenAI-compatible endpoints that only you can use. Models appear as
      <code class="rounded bg-muted px-1.5 py-0.5 text-xs">slug/model</code> in the playground and API.
      Configured headers can inject or override request headers (including
      <code class="rounded bg-muted px-1.5 py-0.5 text-xs">Authorization</code>).
    </p>

    <div v-if="actionError" class="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
      {{ actionError }}
    </div>
    <div v-if="actionNotice" class="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
      {{ actionNotice }}
    </div>

    <DashboardDataNotice :error="error" />
    <UiSkeleton v-if="pending && !data" class="h-40 rounded-xl" />

    <div v-else-if="providers.length === 0" class="rounded-xl border border-dashed border-border p-10 text-center">
      <p class="text-sm font-medium text-foreground">No custom providers yet</p>
      <p class="mt-1 text-sm text-muted-foreground">Add your first OpenAI-compatible endpoint (e.g. vLLM, Ollama, or another gateway).</p>
    </div>

    <div v-else class="space-y-4">
      <UiCard v-for="provider in providers" :key="provider.id" class="gap-4 p-5">
        <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <h3 class="text-base font-semibold">{{ provider.name }}</h3>
              <UiBadge variant="outline">{{ provider.slug }}</UiBadge>
              <UiBadge :variant="provider.enabled ? 'default' : 'secondary'">
                {{ provider.enabled ? "enabled" : "paused" }}
              </UiBadge>
            </div>
            <p class="mt-1 truncate font-mono text-xs text-muted-foreground">{{ provider.baseUrl }}</p>
            <div class="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
              <span>{{ provider.accountCount }} account(s)</span>
              <span>{{ provider.models.length }} model(s)</span>
              <span v-if="provider.extraHeaders && Object.keys(provider.extraHeaders).length > 0">{{ Object.keys(provider.extraHeaders).length }} header(s)</span>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <UiButton size="sm" variant="outline" :disabled="busyAction === `sync-${provider.slug}`" @click="submitSync(provider)">
              {{ busyAction === `sync-${provider.slug}` ? "Syncing…" : "Sync models" }}
            </UiButton>
            <UiButton size="sm" variant="outline" @click="openConnect(provider)">
              Connect key
            </UiButton>
            <UiButton size="sm" variant="outline" @click="openModelAdd(provider)">
              Add model
            </UiButton>
            <UiButton size="sm" variant="outline" @click="openEdit(provider)">
              Edit
            </UiButton>
            <UiButton size="sm" variant="destructive" @click="deleteProvider = provider; deleteOpen = true">
              Delete
            </UiButton>
            <UiSwitch :model-value="provider.enabled" :disabled="busyAction === `toggle-${provider.slug}`" @update:model-value="toggleEnabled(provider, $event)" />
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
                  No models yet — add manually or use "Sync models".
                </td>
              </tr>
              <template v-else>
                <tr v-for="model in provider.models" :key="model.id" class="border-t border-border">
                  <td class="px-3 py-2 font-mono text-xs">{{ model.modelId }}</td>
                  <td class="px-3 py-2 font-mono text-xs text-muted-foreground">{{ model.upstream }}</td>
                  <td class="px-3 py-2 text-xs">{{ modelFlagLabel(model) }}</td>
                  <td class="px-3 py-2">
                    <div class="flex justify-end gap-2">
                      <UiButton size="xs" variant="ghost" @click="openModelEdit(provider, model)">
                        Edit
                      </UiButton>
                      <UiButton size="xs" variant="ghost" class="text-destructive" @click="deleteModelTarget = { provider, model }; deleteModelOpen = true">
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
    </div>

    <UiDialog v-model:open="editOpen" ui.content="sm:max-w-xl">
      <h3 v-if="editForm" class="text-lg font-semibold">Edit {{ editForm.slug }}</h3>
      <div v-if="editForm" class="grid gap-4">
        <label class="grid gap-1.5">
          <span :class="labelClass">Name</span>
          <input v-model="editForm.name" :class="inputClass">
        </label>
        <label class="grid gap-1.5">
          <span :class="labelClass">Base URL</span>
          <input v-model="editForm.baseUrl" :class="inputClass">
        </label>
        <div class="grid gap-1.5">
          <div class="flex items-center justify-between">
            <span :class="labelClass">Extra headers</span>
            <UiButton size="xs" variant="outline" @click="editForm && addHeaderRow(editForm)">
              ＋ Add
            </UiButton>
          </div>
          <div v-for="(header, index) in editForm.headers" :key="index" class="flex items-center gap-2">
            <input v-model="header.key" :class="inputClass" class="w-2/5" placeholder="Header">
            <input v-model="header.value" :class="inputClass" class="flex-1" placeholder="Value">
            <UiButton size="icon-sm" variant="ghost" @click="removeHeaderRow(editForm, index)">
              ✕
            </UiButton>
          </div>
        </div>
        <label class="flex items-center justify-between">
          <span :class="labelClass">Enabled</span>
          <UiSwitch v-model="editForm.enabled" />
        </label>
      </div>
      <div v-if="editForm" class="flex justify-end gap-2">
        <UiButton variant="outline" @click="closeEdit">
          Cancel
        </UiButton>
        <UiButton :disabled="busyAction === 'update'" @click="submitEdit">
          {{ busyAction === "update" ? "Saving…" : "Save" }}
        </UiButton>
      </div>
    </UiDialog>

    <UiDialog v-model:open="modelOpen" ui.content="sm:max-w-xl">
      <h3 v-if="modelProvider" class="text-lg font-semibold">Model — {{ modelProvider.slug }}</h3>
      <div class="grid gap-4">
        <div class="grid gap-1.5">
          <span :class="labelClass">Model ID (public)</span>
          <input v-model="modelForm.modelId" :class="inputClass" class="font-mono" placeholder="qwen3-32b">
          <span class="text-xs text-muted-foreground">Called as <code class="rounded bg-muted px-1">slug/modelId</code>. Exact match — no alias resolution.</span>
        </div>
        <div class="grid gap-1.5">
          <span :class="labelClass">Upstream (sent to the API)</span>
          <input v-model="modelForm.upstream" :class="inputClass" class="font-mono" placeholder="Qwen/Qwen3-32B">
        </div>
        <div class="grid grid-cols-2 gap-3">
          <label class="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <span class="text-sm">reasoning</span>
            <UiSwitch v-model="modelForm.reasoning" size="sm" />
          </label>
          <label class="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <span class="text-sm">toolCall</span>
            <UiSwitch v-model="modelForm.toolCall" size="sm" />
          </label>
          <label class="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <span class="text-sm">vision</span>
            <UiSwitch v-model="modelForm.vision" size="sm" />
          </label>
          <label class="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <span class="text-sm">authless</span>
            <UiSwitch v-model="modelForm.authless" size="sm" />
          </label>
        </div>
        <div class="grid grid-cols-2 gap-3 text-xs text-muted-foreground">
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
        <UiButton variant="outline" @click="closeModel">
          Cancel
        </UiButton>
        <UiButton :disabled="busyAction === 'model-save'" @click="submitModel">
          {{ busyAction === "model-save" ? "Saving…" : "Save model" }}
        </UiButton>
      </div>
    </UiDialog>

    <UiDialog v-model:open="connectOpen" ui.content="sm:max-w-lg">
      <h3 v-if="connectProvider" class="text-lg font-semibold">Connect API key — {{ connectProvider.slug }}</h3>
      <div class="grid gap-4">
        <p class="text-sm text-muted-foreground">
          The key is stored encrypted; the account uses the same health/rotation machinery as other providers.
        </p>
        <label class="grid gap-1.5">
          <span :class="labelClass">Account name (optional)</span>
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
      <h3 v-if="deleteProvider" class="text-lg font-semibold">Delete {{ deleteProvider.slug }}?</h3>
      <p v-if="deleteProvider" class="text-sm text-muted-foreground">
        The provider, its models, and its accounts will be removed. This cannot be undone.
      </p>
      <div class="flex justify-end gap-2">
        <UiButton variant="outline" @click="deleteOpen = false">
          Cancel
        </UiButton>
        <UiButton variant="destructive" :disabled="busyAction === 'delete'" @click="submitDeleteProvider">
          {{ busyAction === "delete" ? "Deleting…" : "Delete" }}
        </UiButton>
      </div>
    </UiDialog>

    <UiDialog v-model:open="deleteModelOpen" ui.content="sm:max-w-md">
      <h3 class="text-lg font-semibold">Remove model?</h3>
      <p class="text-sm text-muted-foreground">
        {{ deleteModelTarget ? `"${deleteModelTarget.model.modelId}" will be removed from "${deleteModelTarget.provider.slug}".` : "" }}
      </p>
      <div class="flex justify-end gap-2">
        <UiButton variant="outline" @click="deleteModelOpen = false">
          Cancel
        </UiButton>
        <UiButton variant="destructive" :disabled="busyAction === 'model-delete'" @click="submitDeleteModel">
          {{ busyAction === "model-delete" ? "Removing…" : "Remove" }}
        </UiButton>
      </div>
    </UiDialog>
  </div>
</template>
