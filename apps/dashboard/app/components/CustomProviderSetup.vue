<script setup lang="ts">
import { cn, requestErrorMessage } from "../../lib/utils";
import type { ActionResult, CustomProviderListItem } from "../../lib/api-types";

interface HeaderRow {
  key: string;
  value: string;
}

interface ModelRow {
  model: string;
  alias: string;
}

const emit = defineEmits<{
  created: [slug: string];
  cancel: [];
}>();

const STEP_COUNT = 2;
const inputClass = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50";
const labelClass = "text-xs font-medium text-muted-foreground";
const dashboardApi = useApi();

const step = ref(1);
const busy = ref("");
const errorMessage = ref("");

const baseUrl = ref("");
const headers = ref<HeaderRow[]>([]);
const apiKey = ref("");
const models = ref<ModelRow[]>([]);
const synced = ref(false);

const providerName = computed(() => {
  try {
    return new URL(baseUrl.value.trim()).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
});

const slug = computed(() => providerName.value
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+/, "")
  .replace(/-{2,}/g, "-")
  .slice(0, 32)
  .replace(/-+$/, ""));

const canCreate = computed(() => baseUrl.value.trim() !== "" && /^[a-z]/.test(slug.value));

function run(action: () => Promise<ActionResult<unknown>>, key: string) {
  busy.value = key;
  errorMessage.value = "";
  return action()
    .then((result) => {
      if (!result.success) {
        errorMessage.value = result.error;
        return false;
      }
      return true;
    })
    .catch((error) => {
      errorMessage.value = requestErrorMessage(error);
      return false;
    })
    .finally(() => {
      busy.value = "";
    });
}

function headersPayload(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of headers.value) {
    const key = row.key.trim();
    const value = row.value.trim();
    if (key && value) result[key] = value;
  }
  return result;
}

async function reloadModels() {
  const list = await dashboardApi.customProviders.list();
  const provider = list.find((row) => row.slug === slug.value);
  if (!provider) return;
  models.value = provider.models.map(toModelRow);
}

function toModelRow(model: CustomProviderListItem["models"][number]): ModelRow {
  const upstream = model.upstream ?? "";
  const source = upstream || model.modelId;
  return { model: source, alias: model.modelId === source ? "" : model.modelId };
}

async function createProvider() {
  if (!canCreate.value) {
    errorMessage.value = "A valid base URL is required.";
    return;
  }
  const ok = await run(() => dashboardApi.customProviders.create({
    slug: slug.value,
    name: providerName.value || slug.value,
    baseUrl: baseUrl.value.trim(),
    extraHeaders: headersPayload(),
  }), "create");
  if (!ok) return;
  step.value = 2;
}

async function syncModels() {
  const ok = await run(() => dashboardApi.customProviders.syncModels({ slug: slug.value, token: apiKey.value.trim() || undefined }), "sync");
  if (!ok) return;
  await reloadModels();
  synced.value = true;
}

async function saveModel(row: ModelRow) {
  const model = row.model.trim();
  if (!model) return;
  const ok = await run(() => dashboardApi.customProviders.addModels({
    slug: slug.value,
    models: [{ modelId: row.alias.trim() || model, upstream: model }],
  }), `save-${model}`);
  if (ok) await reloadModels();
}

async function removeModel(index: number) {
  const row = models.value[index];
  if (!row) return;
  if (!row.model) {
    models.value.splice(index, 1);
    return;
  }
  const ok = await run(() => dashboardApi.customProviders.deleteModel({ slug: slug.value, modelId: row.alias.trim() || row.model.trim() }), `remove-${row.model}`);
  if (ok) await reloadModels();
}

function back() {
  errorMessage.value = "";
  if (step.value === 1) {
    emit("cancel");
    return;
  }
  step.value--;
}

function next() {
  errorMessage.value = "";
  if (step.value === 1) {
    void createProvider();
    return;
  }
  finish();
}

function finish() {
  emit("created", slug.value);
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-4">
    <div class="flex items-center justify-center py-2">
      <template v-for="stepNumber in STEP_COUNT" :key="stepNumber">
        <div class="flex items-center">
          <div
            :class="cn(
              'flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium transition-colors',
              step >= stepNumber ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
            )"
          >
            <UiIcon v-if="step > stepNumber" name="i-lucide-check" class="size-4" />
            <span v-else>{{ stepNumber }}</span>
          </div>
          <div v-if="stepNumber < STEP_COUNT" :class="cn('h-px w-10 transition-colors', step > stepNumber ? 'bg-primary' : 'bg-border')" />
        </div>
      </template>
    </div>

    <div class="min-h-0 flex-1 space-y-4 overflow-y-auto">
      <div v-if="errorMessage" class="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {{ errorMessage }}
      </div>

      <div v-if="step === 1" class="space-y-4">
        <label class="grid gap-1.5">
          <span :class="labelClass">Base URL</span>
          <input v-model="baseUrl" :class="inputClass" class="font-mono" placeholder="https://vllm.example.com/v1">
          <span class="font-mono text-xs text-muted-foreground">{{ slug ? `name: ${providerName} · slug: ${slug}` : "name and slug are generated from the base URL" }}</span>
        </label>
        <div class="grid gap-1.5">
          <div class="flex items-center justify-between">
            <span :class="labelClass">Headers</span>
            <UiButton size="xs" variant="outline" @click="headers.push({ key: '', value: '' })">
              Add
            </UiButton>
          </div>
          <div v-for="(header, index) in headers" :key="index" class="flex items-center gap-2">
            <input v-model="header.key" :class="inputClass" class="w-2/5" placeholder="Header">
            <input v-model="header.value" :class="inputClass" class="flex-1" placeholder="Value">
            <UiButton size="icon-sm" variant="ghost" @click="headers.splice(index, 1)">
              ✕
            </UiButton>
          </div>
        </div>
      </div>

      <div v-if="step === 2" class="space-y-3">
        <label class="grid gap-1.5">
          <span :class="labelClass">API key (optional, only to refresh models)</span>
          <input v-model="apiKey" type="password" :class="inputClass" class="font-mono" placeholder="sk-...">
        </label>
        <div class="flex items-center justify-between">
          <p class="text-sm font-medium">Models ({{ models.length }})</p>
          <div class="flex items-center gap-2">
            <UiButton size="xs" variant="outline" :disabled="busy === 'sync'" @click="syncModels">
              {{ busy === "sync" ? "Syncing…" : "Sync from upstream" }}
            </UiButton>
            <UiButton size="xs" variant="outline" @click="models.push({ model: '', alias: '' })">
              Add
            </UiButton>
          </div>
        </div>
        <div class="space-y-2">
          <div v-if="models.length === 0" class="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
            No models. Sync from the upstream or add one manually.
          </div>
          <div v-for="(row, index) in models" :key="index" class="rounded-lg border border-border p-3">
            <div class="flex items-center gap-2">
              <input v-model="row.model" :class="inputClass" class="flex-1 font-mono" placeholder="model">
              <input v-model="row.alias" :class="inputClass" class="flex-1 font-mono" placeholder="alias (optional)">
              <UiButton size="xs" :disabled="busy === `save-${row.model}` || !row.model.trim()" @click="saveModel(row)">
                Save
              </UiButton>
              <UiButton size="icon-xs" variant="ghost" @click="removeModel(index)">
                ✕
              </UiButton>
            </div>
          </div>
        </div>
        <p v-if="synced" class="text-xs text-muted-foreground">Synced {{ models.length }} model(s). Add the provider API key from the account wizard when you're ready to route requests.</p>
      </div>
    </div>

    <div class="flex flex-row items-center justify-between gap-2">
      <UiButton type="button" variant="ghost" :disabled="busy !== ''" @click="back">
        <UiIcon name="i-lucide-arrow-left" class="size-4" />
        {{ step === 1 ? "Cancel" : "Back" }}
      </UiButton>
      <UiButton type="button" :disabled="busy !== '' || (step === 1 && !canCreate)" @click="next">
        {{ step === 1 ? (busy === "create" ? "Creating…" : "Next") : "Finish" }}
        <UiIcon name="i-lucide-arrow-right" class="size-4" />
      </UiButton>
    </div>
  </div>
</template>
