<script setup lang="ts">
import { cn } from "../../lib/utils";
import type {
  ActionResult,
  CustomProviderListItem,
  CustomProviderModelFlags,
  CustomProviderModelMeta,
} from "../../lib/dashboard-api-types";

interface HeaderRow {
  key: string;
  value: string;
}

interface WizardModelRow {
  modelId: string;
  upstream: string;
  reasoning: boolean;
  toolCall: boolean;
  vision: boolean;
  authless: boolean;
  responsesApi: boolean;
}

const open = defineModel<boolean>("open", { default: false });

const emit = defineEmits<{
  finished: [provider: CustomProviderListItem];
}>();

const STEP_LABELS = ["Basics", "Connect", "Models", "API Key", "Review"] as const;
const inputClass = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50";
const labelClass = "text-sm font-medium";
const dashboardApi = useDashboardApi();

const activeStep = ref(1);
const busy = ref<string>("");
const errorMessage = ref("");
const notice = ref("");

const name = ref("");
const slug = ref("");
const baseUrl = ref("");
const headers = ref<HeaderRow[]>([]);
const createdProvider = ref<CustomProviderListItem | null>(null);
const providerModels = ref<WizardModelRow[]>([]);
const connectToken = ref("");
const connectName = ref("");
const discoveredCount = ref(0);
const step2Touched = ref(false);

function reset() {
  activeStep.value = 1;
  busy.value = "";
  errorMessage.value = "";
  notice.value = "";
  name.value = "";
  slug.value = "";
  baseUrl.value = "";
  headers.value = [];
  createdProvider.value = null;
  providerModels.value = [];
  connectToken.value = "";
  connectName.value = "";
  discoveredCount.value = 0;
  step2Touched.value = false;
}

watch(open, (value) => {
  if (value) reset();
});

function addHeader() {
  headers.value.push({ key: "", value: "" });
}

function removeHeader(index: number) {
  headers.value.splice(index, 1);
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

function toWizardRow(model: CustomProviderListItem["models"][number]): WizardModelRow {
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

async function currentProvider(): Promise<CustomProviderListItem | null> {
  const list = await dashboardApi.customProviders.list();
  return list.find((row) => row.slug === slug.value) ?? null;
}

async function reloadModels() {
  const provider = await currentProvider();
  if (!provider) return;
  createdProvider.value = provider;
  providerModels.value = provider.models.map(toWizardRow);
}

function runWizardAction(action: () => Promise<ActionResult<unknown>>, key: string) {
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

function canProceedFromBasics() {
  return name.value.trim() !== "" && slug.value.trim() !== "" && baseUrl.value.trim() !== "";
}

async function goNext() {
  errorMessage.value = "";
  if (activeStep.value === 1) {
    if (!canProceedFromBasics()) {
      errorMessage.value = "Name, slug, and base URL are required.";
      return;
    }
    const ok = await runWizardAction(() => dashboardApi.customProviders.create({
      slug: slug.value.trim().toLowerCase(),
      name: name.value.trim(),
      baseUrl: baseUrl.value.trim(),
      extraHeaders: headersPayload(),
    }), "create");
    if (!ok) return;
    await reloadModels();
    notice.value = `Provider "${slug.value}" created — now connect it and add models.`;
    activeStep.value = 2;
    return;
  }
  activeStep.value++;
  if (activeStep.value === 3) {
    await reloadModels();
  }
}

function goBack() {
  errorMessage.value = "";
  if (activeStep.value === 1) {
    open.value = false;
    return;
  }
  activeStep.value--;
}

async function syncModels() {
  const ok = await runWizardAction(() => dashboardApi.customProviders.syncModels({ slug: slug.value }), "sync");
  if (!ok) return;
  await reloadModels();
  const provider = createdProvider.value;
  discoveredCount.value = provider?.models.length ?? 0;
  step2Touched.value = true;
  notice.value = `Sync finished — ${discoveredCount.value} model(s) available now.`;
}

function addModelRow() {
  providerModels.value.push({ modelId: "", upstream: "", reasoning: true, toolCall: true, vision: true, authless: false, responsesApi: false });
}

function removeModelRow(index: number) {
  const row = providerModels.value[index];
  if (!row) return;
  if (!row.modelId) {
    providerModels.value.splice(index, 1);
    return;
  }
  void runWizardAction(() => dashboardApi.customProviders.deleteModel({ slug: slug.value, modelId: row.modelId }), `remove-${row.modelId}`).then(async (ok) => {
    if (!ok) return;
    await reloadModels();
  });
}

function metaFor(row: WizardModelRow): CustomProviderModelMeta {
  return { reasoning: row.reasoning, toolCall: row.toolCall, vision: row.vision };
}

function flagsFor(row: WizardModelRow): CustomProviderModelFlags {
  return { responses_api: row.responsesApi };
}

function saveModelRow(row: WizardModelRow) {
  const modelId = row.modelId.trim();
  if (!modelId) return;
  void runWizardAction(() => dashboardApi.customProviders.addModels({
    slug: slug.value,
    models: [{
      modelId,
      upstream: row.upstream.trim() || undefined,
      authless: row.authless,
      meta: metaFor(row),
      customFlags: flagsFor(row),
    }],
  }), `save-${modelId}`).then(async (ok) => {
    if (!ok) return;
    notice.value = `Model "${modelId}" saved.`;
    await reloadModels();
  });
}

async function connectKey() {
  const token = connectToken.value.trim();
  if (!token) return;
  const ok = await runWizardAction(() => dashboardApi.customProviders.connect({
    slug: slug.value,
    token,
    name: connectName.value.trim() || undefined,
  }), "connect");
  if (!ok) return;
  connectToken.value = "";
  notice.value = "API key connected.";
}

function modelCount() {
  return providerModels.value.filter((row) => row.modelId.trim() !== "").length;
}

function finish() {
  if (createdProvider.value) {
    emit("finished", createdProvider.value);
  }
  open.value = false;
}
</script>

<template>
  <UiDialog v-model:open="open" :prevent-outside-close="activeStep > 1" ui.content="sm:max-w-2xl">
    <template v-if="open">
      <div class="flex items-center justify-between">
        <h3 class="text-lg font-semibold">
          Add Custom Provider
        </h3>
        <button type="button" class="text-muted-foreground hover:text-foreground" aria-label="Close" @click="open = false">
          ✕
        </button>
      </div>

      <ol class="flex items-center gap-1 text-xs">
        <li v-for="(label, index) in STEP_LABELS" :key="label" class="flex items-center gap-1">
          <span v-if="index > 0" class="mx-1 h-px w-4 bg-border" />
          <span
            :class="cn(
              'rounded-full px-2.5 py-1 font-medium',
              index + 1 === activeStep ? 'bg-primary text-primary-foreground' : index + 1 < activeStep ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground',
            )"
          >
            {{ index + 1 }}. {{ label }}
          </span>
        </li>
      </ol>

      <div v-if="errorMessage" class="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {{ errorMessage }}
      </div>
      <div v-if="notice" class="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
        {{ notice }}
      </div>

      <div v-if="activeStep === 1" class="grid gap-4">
        <label class="grid gap-1.5">
          <span :class="labelClass">Name</span>
          <input v-model="name" :class="inputClass" placeholder="My vLLM">
        </label>
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="grid gap-1.5">
            <span :class="labelClass">Slug</span>
            <input v-model="slug" :class="inputClass" class="font-mono" placeholder="my-vllm">
          </label>
          <label class="grid gap-1.5">
            <span :class="labelClass">Base URL</span>
            <input v-model="baseUrl" :class="inputClass" class="font-mono" placeholder="https://vllm.example.com/v1">
          </label>
        </div>
        <div class="grid gap-1.5">
          <div class="flex items-center justify-between">
            <span :class="labelClass">Extra headers</span>
            <UiButton size="xs" variant="outline" @click="addHeader">
              ＋ Add
            </UiButton>
          </div>
          <div v-for="(header, index) in headers" :key="index" class="flex items-center gap-2">
            <input v-model="header.key" :class="inputClass" class="w-2/5" placeholder="Header">
            <input v-model="header.value" :class="inputClass" class="flex-1" placeholder="Value">
            <UiButton size="icon-sm" variant="ghost" @click="removeHeader(index)">
              ✕
            </UiButton>
          </div>
        </div>
        <p class="text-xs text-muted-foreground">
          Slug uses <code class="rounded bg-muted px-1">[a-z0-9_-]</code> and is immutable. Headers can override defaults (including Authorization).
        </p>
      </div>

      <div v-if="activeStep === 2" class="grid gap-4">
        <div class="rounded-lg border border-border bg-muted/20 px-4 py-3">
          <p class="text-sm font-medium">{{ baseUrl || slug }}</p>
          <p class="mt-0.5 text-xs text-muted-foreground">
            Sync reads <code class="rounded bg-muted px-1">GET {baseUrl}/models</code> through the gateway. Private hosts are blocked (SSRF guard).
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <UiButton :disabled="busy === 'sync'" @click="syncModels">
            {{ busy === "sync" ? "Syncing…" : "✨ Sync models from upstream" }}
          </UiButton>
          <span v-if="step2Touched" class="text-sm text-muted-foreground">{{ discoveredCount }} model(s) added to this provider.</span>
        </div>
        <p class="text-sm text-muted-foreground">
          Skip this step if the endpoint has no <code class="rounded bg-muted px-1">/models</code> — you can add models manually on the next step.
        </p>
      </div>

      <div v-if="activeStep === 3" class="grid gap-3">
        <div class="flex items-center justify-between">
          <p class="text-sm font-medium">Models ({{ modelCount() }})</p>
          <UiButton size="xs" variant="outline" @click="addModelRow">
            ＋ Add manual
          </UiButton>
        </div>
        <div class="max-h-72 space-y-2 overflow-y-auto pr-1">
          <div v-if="providerModels.length === 0" class="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
            No models yet. Use "Sync models" on the previous step or add one manually.
          </div>
          <div v-for="(row, index) in providerModels" :key="index" class="rounded-lg border border-border p-3">
            <div class="flex items-center gap-2">
              <input v-model="row.modelId" :class="inputClass" class="flex-1 font-mono" placeholder="model id, e.g. qwen3-32b">
              <input v-model="row.upstream" :class="inputClass" class="flex-1 font-mono" placeholder="upstream name (optional)">
              <UiButton size="xs" :disabled="busy === `save-${row.modelId}` || !row.modelId.trim()" @click="saveModelRow(row)">
                {{ busy === `save-${row.modelId}` ? "…" : "Save" }}
              </UiButton>
              <UiButton size="icon-xs" variant="ghost" @click="removeModelRow(index)">
                ✕
              </UiButton>
            </div>
            <div class="mt-2 flex flex-wrap items-center gap-4 text-xs">
              <label class="flex items-center gap-1.5">
                <UiSwitch v-model="row.reasoning" size="sm" />
                reasoning
              </label>
              <label class="flex items-center gap-1.5">
                <UiSwitch v-model="row.toolCall" size="sm" />
                toolCall
              </label>
              <label class="flex items-center gap-1.5">
                <UiSwitch v-model="row.vision" size="sm" />
                vision
              </label>
              <label class="flex items-center gap-1.5">
                <UiSwitch v-model="row.authless" size="sm" />
                authless
              </label>
              <label class="flex items-center gap-1.5">
                <UiSwitch v-model="row.responsesApi" size="sm" />
                responses_api
              </label>
            </div>
          </div>
        </div>
        <p class="text-xs text-muted-foreground">
          Model ids are exact-match under <code class="rounded bg-muted px-1">{{ slug }}/modelId</code>. Edit capabilities later from the provider list.
        </p>
      </div>

      <div v-if="activeStep === 4" class="grid gap-4">
        <p class="text-sm text-muted-foreground">
          Optional: attach an API key so requests are authenticated. Skip if the endpoint is public/authless.
        </p>
        <label class="grid gap-1.5">
          <span :class="labelClass">Account name (optional)</span>
          <input v-model="connectName" :class="inputClass" placeholder="prod key">
        </label>
        <label class="grid gap-1.5">
          <span :class="labelClass">API key</span>
          <input v-model="connectToken" type="password" :class="inputClass" class="font-mono" placeholder="sk-...">
        </label>
        <div v-if="connectToken.trim()" class="flex">
          <UiButton variant="outline" size="sm" :disabled="busy === 'connect'" @click="connectKey">
            {{ busy === "connect" ? "Validating…" : "Validate & connect" }}
          </UiButton>
        </div>
      </div>

      <div v-if="activeStep === 5" class="grid gap-3 text-sm">
        <div class="rounded-lg border border-border px-4 py-3">
          <p class="font-semibold">{{ name }}</p>
          <dl class="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <div>
              <dt>slug</dt>
              <dd class="font-mono text-foreground">{{ slug }}</dd>
            </div>
            <div>
              <dt>base url</dt>
              <dd class="font-mono text-foreground">{{ baseUrl }}</dd>
            </div>
            <div>
              <dt>models</dt>
              <dd>{{ modelCount() }}</dd>
            </div>
            <div>
              <dt>api key</dt>
              <dd>{{ connectToken ? "connected" : "not set (optional)" }}</dd>
            </div>
          </dl>
        </div>
        <p class="text-xs text-muted-foreground">
          Use it as <code class="rounded bg-muted px-1.5 py-0.5">{{ slug }}/&lt;modelId&gt;</code> in the playground or any OpenAI-compatible client.
        </p>
      </div>

      <div class="flex justify-between gap-2">
        <UiButton variant="outline" :disabled="busy !== ''" @click="goBack">
          {{ activeStep === 1 ? "Cancel" : "← Back" }}
        </UiButton>
        <div class="flex gap-2">
          <UiButton v-if="activeStep < 5" :disabled="busy !== '' || (activeStep === 1 && !canProceedFromBasics())" @click="goNext">
            {{ activeStep === 1 ? (busy === "create" ? "Creating…" : "Create provider") : "Next →" }}
          </UiButton>
          <UiButton v-else :disabled="busy !== ''" @click="finish">
            ✔ Finish
          </UiButton>
        </div>
      </div>
    </template>
  </UiDialog>
</template>
