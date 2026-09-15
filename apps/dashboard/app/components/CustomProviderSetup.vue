<script setup lang="ts">
import { cn } from "../../lib/utils";
import type {
  ActionResult,
  CustomProviderListItem,
  CustomProviderModelFlags,
  CustomProviderModelMeta,
} from "../../lib/api-types";

interface HeaderRow {
  key: string;
  value: string;
}

interface ModelRow {
  modelId: string;
  upstream: string;
  reasoning: boolean;
  toolCall: boolean;
  vision: boolean;
  authless: boolean;
  responsesApi: boolean;
}

const emit = defineEmits<{
  created: [slug: string];
  cancel: [];
}>();

const STEP_COUNT = 3;
const inputClass = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50";
const labelClass = "text-xs font-medium text-muted-foreground";
const dashboardApi = useApi();

const step = ref(1);
const busy = ref("");
const errorMessage = ref("");

const name = ref("");
const baseUrl = ref("");
const headers = ref<HeaderRow[]>([]);
const models = ref<ModelRow[]>([]);
const synced = ref(false);
const connectName = ref("");
const connectToken = ref("");

const slug = computed(() => name.value
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+/, "")
  .replace(/-{2,}/g, "-")
  .slice(0, 32)
  .replace(/-+$/, ""));

const canCreate = computed(() => name.value.trim() !== "" && slug.value !== "" && baseUrl.value.trim() !== "");

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
    .catch(() => {
      errorMessage.value = "Request failed. Please try again.";
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
  return {
    modelId: model.modelId,
    upstream: model.upstream ?? "",
    reasoning: model.meta?.reasoning ?? true,
    toolCall: model.meta?.toolCall ?? true,
    vision: model.meta?.vision ?? true,
    authless: model.authless,
    responsesApi: model.customFlags?.responses_api ?? false,
  };
}

async function createProvider() {
  if (!canCreate.value) {
    errorMessage.value = "Name and base URL are required.";
    return;
  }
  const ok = await run(() => dashboardApi.customProviders.create({
    slug: slug.value,
    name: name.value.trim(),
    baseUrl: baseUrl.value.trim(),
    extraHeaders: headersPayload(),
  }), "create");
  if (!ok) return;
  step.value = 2;
}

async function syncModels() {
  const ok = await run(() => dashboardApi.customProviders.syncModels({ slug: slug.value }), "sync");
  if (!ok) return;
  await reloadModels();
  synced.value = true;
}

function metaFor(row: ModelRow): CustomProviderModelMeta {
  return { reasoning: row.reasoning, toolCall: row.toolCall, vision: row.vision };
}

function flagsFor(row: ModelRow): CustomProviderModelFlags {
  return { responses_api: row.responsesApi };
}

async function saveModel(row: ModelRow) {
  const modelId = row.modelId.trim();
  if (!modelId) return;
  const ok = await run(() => dashboardApi.customProviders.addModels({
    slug: slug.value,
    models: [{
      modelId,
      upstream: row.upstream.trim() || undefined,
      authless: row.authless,
      meta: metaFor(row),
      customFlags: flagsFor(row),
    }],
  }), `save-${modelId}`);
  if (ok) await reloadModels();
}

async function removeModel(index: number) {
  const row = models.value[index];
  if (!row) return;
  if (!row.modelId) {
    models.value.splice(index, 1);
    return;
  }
  const ok = await run(() => dashboardApi.customProviders.deleteModel({ slug: slug.value, modelId: row.modelId }), `remove-${row.modelId}`);
  if (ok) await reloadModels();
}

async function connectKey() {
  if (!connectToken.value.trim()) return;
  const ok = await run(() => dashboardApi.customProviders.connect({
    slug: slug.value,
    token: connectToken.value.trim(),
    name: connectName.value.trim() || undefined,
  }), "connect");
  if (!ok) return;
  emit("created", slug.value);
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
  if (step.value === 2) {
    step.value = 3;
  }
}

function finish() {
  if (connectToken.value.trim()) {
    void connectKey();
    return;
  }
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
          <span :class="labelClass">Name</span>
          <input v-model="name" :class="inputClass" placeholder="My vLLM">
          <span class="font-mono text-xs text-muted-foreground">{{ slug ? `slug: ${slug}` : "slug is generated from the name" }}</span>
        </label>
        <label class="grid gap-1.5">
          <span :class="labelClass">Base URL</span>
          <input v-model="baseUrl" :class="inputClass" class="font-mono" placeholder="https://vllm.example.com/v1">
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
        <div class="flex items-center justify-between">
          <p class="text-sm font-medium">Models ({{ models.length }})</p>
          <div class="flex items-center gap-2">
            <UiButton size="xs" variant="outline" :disabled="busy === 'sync'" @click="syncModels">
              {{ busy === "sync" ? "Syncing…" : "Sync from upstream" }}
            </UiButton>
            <UiButton size="xs" variant="outline" @click="models.push({ modelId: '', upstream: '', reasoning: true, toolCall: true, vision: true, authless: false, responsesApi: false })">
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
              <input v-model="row.modelId" :class="inputClass" class="flex-1 font-mono" placeholder="model id">
              <input v-model="row.upstream" :class="inputClass" class="flex-1 font-mono" placeholder="upstream (optional)">
              <UiButton size="xs" :disabled="busy === `save-${row.modelId}` || !row.modelId.trim()" @click="saveModel(row)">
                Save
              </UiButton>
              <UiButton size="icon-xs" variant="ghost" @click="removeModel(index)">
                ✕
              </UiButton>
            </div>
            <div class="mt-2 flex flex-wrap items-center gap-4 text-xs">
              <label v-for="flag in (['reasoning', 'toolCall', 'vision', 'authless', 'responsesApi'] as const)" :key="flag" class="flex items-center gap-1.5">
                <UiSwitch v-model="row[flag]" size="sm" />
                {{ flag }}
              </label>
            </div>
          </div>
        </div>
        <p v-if="synced" class="text-xs text-muted-foreground">Synced {{ models.length }} model(s).</p>
      </div>

      <div v-if="step === 3" class="space-y-4">
        <p class="text-sm text-muted-foreground">Connect an API key to start routing requests. Optional — you can also add it later.</p>
        <label class="grid gap-1.5">
          <span :class="labelClass">Name (optional)</span>
          <input v-model="connectName" :class="inputClass" placeholder="prod key">
        </label>
        <label class="grid gap-1.5">
          <span :class="labelClass">API key</span>
          <input v-model="connectToken" type="password" :class="inputClass" class="font-mono" placeholder="sk-...">
        </label>
      </div>
    </div>

    <div class="flex flex-row items-center justify-between gap-2">
      <UiButton type="button" variant="ghost" :disabled="busy !== ''" @click="back">
        <UiIcon name="i-lucide-arrow-left" class="size-4" />
        {{ step === 1 ? "Cancel" : "Back" }}
      </UiButton>
      <UiButton v-if="step < STEP_COUNT" type="button" :disabled="busy !== '' || (step === 1 && !canCreate)" @click="next">
        {{ step === 1 ? (busy === "create" ? "Creating…" : "Create provider") : "Next" }}
        <UiIcon name="i-lucide-arrow-right" class="size-4" />
      </UiButton>
      <UiButton v-else type="button" :disabled="busy !== ''" @click="finish">
        {{ busy === "connect" ? "Connecting…" : "Finish" }}
      </UiButton>
    </div>
  </div>
</template>
