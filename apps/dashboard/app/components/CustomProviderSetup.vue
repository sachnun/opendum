<script setup lang="ts">
import { cn, requestErrorMessage } from "../../lib/utils";
import { COMMON_HEADER_NAMES } from "../../lib/headers";
import type { ActionResult } from "../../lib/api-types";

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
const labelClass = "text-xs font-medium text-foreground";
const dashboardApi = useApi();

const step = ref(1);
const busy = ref("");
const errorMessage = ref("");
const providerCreated = ref(false);

const name = ref("");
const baseUrl = ref("");
const headers = ref<HeaderRow[]>([{ key: "", value: "" }]);
const apiKey = ref("");
const models = ref<ModelRow[]>([{ model: "", alias: "" }]);
const synced = ref(false);

const MULTIPART_SUFFIXES = new Set(["ac", "biz", "co", "com", "edu", "go", "gov", "mil", "my", "ne", "net", "or", "org", "sch", "web"]);

const host = computed(() => {
  try {
    return new URL(baseUrl.value.trim()).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
});

const domain = computed(() => {
  const labels = host.value.split(".");
  if (labels.length < 2) return host.value;
  const suffix = labels[labels.length - 2] ?? "";
  const extension = labels[labels.length - 1] ?? "";
  const suffixLength = labels.length > 2 && extension.length === 2 && MULTIPART_SUFFIXES.has(suffix) ? 2 : 1;
  return labels[labels.length - 1 - suffixLength] ?? "";
});

const slug = computed(() => domain.value
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+/, "")
  .replace(/-{2,}/g, "-")
  .slice(0, 32)
  .replace(/-+$/, ""));

const canCreate = computed(() => name.value.trim() !== "" && baseUrl.value.trim() !== "" && /^[a-z]/.test(slug.value));
const filledModels = computed(() => models.value.filter((row) => row.model.trim() !== ""));
const saving = computed(() => busy.value === "create" || busy.value === "connect" || busy.value === "models");

watch(headers, (rows) => {
  for (let index = rows.length - 2; index >= 0; index--) {
    if (rows[index].key.trim() === "") rows.splice(index, 1);
  }
  const last = rows[rows.length - 1];
  if (!last || last.key.trim() !== "") rows.push({ key: "", value: "" });
}, { deep: true });

watch(models, (rows) => {
  for (let index = rows.length - 2; index >= 0; index--) {
    if (rows[index].model.trim() === "") rows.splice(index, 1);
  }
  const last = rows[rows.length - 1];
  if (!last || last.model.trim() !== "") rows.push({ model: "", alias: "" });
}, { deep: true });

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

async function ensureProvider(): Promise<boolean> {
  if (providerCreated.value) return true;
  const ok = await run(() => dashboardApi.customProviders.create({
    slug: slug.value,
    name: name.value.trim(),
    baseUrl: baseUrl.value.trim(),
    extraHeaders: headersPayload(),
  }), "create");
  if (ok) providerCreated.value = true;
  return ok;
}

async function syncModels() {
  busy.value = "sync";
  errorMessage.value = "";
  try {
    const result = await dashboardApi.customProviders.previewModels({
      baseUrl: baseUrl.value.trim(),
      extraHeaders: headersPayload(),
      token: apiKey.value.trim() || undefined,
    });
    if (!result.success) {
      errorMessage.value = result.error;
      return;
    }
    models.value = result.data.models.length > 0
      ? result.data.models.map((model) => {
        const source = model.upstream || model.modelId;
        return { model: source, alias: model.modelId === source ? "" : model.modelId };
      })
      : [{ model: "", alias: "" }];
    synced.value = true;
  } catch (error) {
    errorMessage.value = requestErrorMessage(error);
  } finally {
    busy.value = "";
  }
}

async function finish() {
  const token = apiKey.value.trim();
  if (!token) {
    errorMessage.value = "API key is required.";
    return;
  }
  if (!(await ensureProvider())) return;
  if (!(await run(() => dashboardApi.customProviders.connect({ slug: slug.value, token }), "connect"))) return;
  const rows = filledModels.value;
  if (rows.length > 0) {
    const payload = rows.map((row) => ({ modelId: row.alias.trim() || row.model.trim(), upstream: row.model.trim() }));
    if (!(await run(() => dashboardApi.customProviders.addModels({ slug: slug.value, models: payload }), "models"))) return;
  }
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
    if (!canCreate.value) {
      errorMessage.value = "Name and a valid base URL are required.";
      return;
    }
    step.value = 2;
    return;
  }
  void finish();
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
          <span :class="labelClass">Name <span aria-hidden="true" class="text-destructive">*</span></span>
          <input v-model="name" :class="inputClass" placeholder="My vLLM">
        </label>
        <label class="grid gap-1.5">
          <span :class="labelClass">Base URL <span aria-hidden="true" class="text-destructive">*</span></span>
          <input v-model="baseUrl" :class="inputClass" class="font-mono" placeholder="https://vllm.example.com/v1">
        </label>
        <div class="grid gap-2">
          <span :class="labelClass">Headers</span>
          <div v-for="(header, index) in headers" :key="index" class="flex items-center gap-2">
            <input v-model="header.key" :class="inputClass" class="flex-1" list="custom-provider-header-names" placeholder="Header">
            <input v-model="header.value" :class="inputClass" class="flex-1" placeholder="Value">
          </div>
          <datalist id="custom-provider-header-names">
            <option v-for="headerName in COMMON_HEADER_NAMES" :key="headerName" :value="headerName" />
          </datalist>
        </div>
      </div>

      <div v-if="step === 2" class="space-y-3">
        <label class="grid gap-1.5">
          <span :class="labelClass">API key <span aria-hidden="true" class="text-destructive">*</span></span>
          <input v-model="apiKey" type="password" :class="inputClass" class="font-mono" placeholder="sk-...">
        </label>
        <div class="grid gap-2">
          <div class="flex items-center justify-between">
            <span :class="labelClass">Models ({{ filledModels.length }})</span>
            <UiTooltip text="Refresh">
              <UiButton size="icon-sm" variant="outline" :disabled="busy === 'sync' || baseUrl.trim() === ''" @click="syncModels">
                <UiIcon name="i-lucide-refresh-cw" :class="['size-4', busy === 'sync' ? 'animate-spin' : '']" />
              </UiButton>
            </UiTooltip>
          </div>
          <div v-for="(row, index) in models" :key="index" class="flex items-center gap-2">
            <input v-model="row.model" :class="inputClass" class="flex-1 font-mono" placeholder="model">
            <div class="min-w-0 flex-1">
              <ModelAliasSelect v-model="row.alias" :default-id="row.model" />
            </div>
          </div>
          <p v-if="synced" class="text-xs text-muted-foreground">Synced {{ filledModels.length }} model(s).</p>
        </div>
      </div>
    </div>

    <div class="flex flex-row items-center justify-between gap-2">
      <UiButton type="button" variant="ghost" :disabled="busy !== ''" @click="back">
        <UiIcon name="i-lucide-arrow-left" class="size-4" />
        Back
      </UiButton>
      <UiButton type="button" variant="ghost" class="ml-auto" :disabled="busy !== '' || (step === 1 && !canCreate) || (step === 2 && apiKey.trim() === '')" @click="next">
        {{ step === 1 ? "Next" : saving ? "Saving…" : "Finish" }}
        <UiIcon name="i-lucide-arrow-right" class="size-4" />
      </UiButton>
    </div>
  </div>
</template>
