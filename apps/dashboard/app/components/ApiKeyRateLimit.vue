<script setup lang="ts">
interface RateLimitRuleInput {
  target: string;
  targetType: "model" | "family";
  perMinute: number | null;
  perHour: number | null;
  perDay: number | null;
}

interface RateLimitRuleState {
  target: string;
  targetType: "model" | "family";
  perMinute: string;
  perHour: string;
  perDay: string;
}

const props = defineProps<{
  apiKeyId: string;
  availableModels: string[];
  availableFamilies: string[];
  initialRules: RateLimitRuleInput[];
}>();

const { $client } = useNuxtApp();
const isSaving = ref(false);
const savedRules = ref<RateLimitRuleInput[]>(props.initialRules);
const draftRules = ref<RateLimitRuleState[]>(props.initialRules.map(ruleToState));
const addMode = ref<"model" | "family">("model");
const pickerOpen = ref(false);
const search = ref("");
const errorMessage = ref("");

function ruleToState(rule: RateLimitRuleInput): RateLimitRuleState {
  return { target: rule.target, targetType: rule.targetType, perMinute: rule.perMinute != null ? String(rule.perMinute) : "", perHour: rule.perHour != null ? String(rule.perHour) : "", perDay: rule.perDay != null ? String(rule.perDay) : "" };
}

function stateToRule(state: RateLimitRuleState): RateLimitRuleInput {
  return { target: state.target, targetType: state.targetType, perMinute: state.perMinute ? Number.parseInt(state.perMinute, 10) : null, perHour: state.perHour ? Number.parseInt(state.perHour, 10) : null, perDay: state.perDay ? Number.parseInt(state.perDay, 10) : null };
}

function rulesEqual(left: RateLimitRuleInput[], right: RateLimitRuleInput[]): boolean {
  if (left.length !== right.length) return false;
  const serialize = (rule: RateLimitRuleInput) => `${rule.targetType}:${rule.target}:${rule.perMinute}:${rule.perHour}:${rule.perDay}`;
  const leftSet = new Set(left.map(serialize));
  return right.every((rule) => leftSet.has(serialize(rule)));
}

function resetDraft() {
  draftRules.value = savedRules.value.map(ruleToState);
  pickerOpen.value = false;
  addMode.value = "model";
  search.value = "";
  errorMessage.value = "";
}

function addRule(target: string) {
  if (usedTargets.value.has(`${addMode.value}:${target}`)) return;
  draftRules.value = [...draftRules.value, { target, targetType: addMode.value, perMinute: "", perHour: "", perDay: "" }];
  pickerOpen.value = false;
  search.value = "";
}

function removeRule(index: number) {
  draftRules.value = draftRules.value.filter((_, ruleIndex) => ruleIndex !== index);
}

function updateRule(index: number, field: "perMinute" | "perHour" | "perDay", value: string) {
  if (value !== "" && !/^\d+$/.test(value)) return;
  draftRules.value = draftRules.value.map((rule, ruleIndex) => (ruleIndex === index ? { ...rule, [field]: value } : rule));
}

async function save() {
  const rules = draftRules.value.map(stateToRule);
  for (const rule of rules) {
    if (rule.perMinute == null && rule.perHour == null && rule.perDay == null) {
      errorMessage.value = `Set at least one limit for ${rule.target}`;
      return;
    }
  }

  isSaving.value = true;
  errorMessage.value = "";
  try {
    const result = await $client.apiKeys.updateRateLimits.mutate({ id: props.apiKeyId, rules });
    if (!result.success) throw new Error(result.error);
    savedRules.value = result.data.rules;
    draftRules.value = result.data.rules.map(ruleToState);
    pickerOpen.value = false;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Failed to update rate limits";
  } finally {
    isSaving.value = false;
  }
}

const usedTargets = computed(() => new Set(draftRules.value.map((rule) => `${rule.targetType}:${rule.target}`)));
const hasChanges = computed(() => !rulesEqual(savedRules.value, draftRules.value.map(stateToRule)));
const pickerItems = computed(() => {
  const source = addMode.value === "model" ? props.availableModels : props.availableFamilies;
  const query = search.value.trim().toLowerCase();
  return source
    .filter((item) => !usedTargets.value.has(`${addMode.value}:${item}`))
    .filter((item) => !query || item.toLowerCase().includes(query));
});
</script>

<template>
  <section class="flex h-full flex-col p-4 max-lg:p-0">
    <div class="hidden items-start justify-between gap-3 lg:flex">
      <div class="inline-flex items-center gap-2 text-sm font-semibold">
        <UiIcon name="i-lucide-gauge" class="size-4 text-muted-foreground" />
        <span>Rate Limits</span>
      </div>
      <UiBadge variant="outline" class="shrink-0">{{ savedRules.length }} rule{{ savedRules.length === 1 ? '' : 's' }}</UiBadge>
    </div>

    <div class="flex-1 space-y-3 lg:mt-5">
      <div v-if="draftRules.length === 0" class="px-1 py-4 text-xs text-muted-foreground">
        No rate limits configured. Requests use the default unlimited behavior.
      </div>
      <div v-else class="max-h-64 space-y-2 overflow-y-auto pr-1">
        <div v-for="(rule, index) in draftRules" :key="`${rule.targetType}:${rule.target}`" class="border-b border-border/60 pb-3">
          <div class="flex items-center justify-between gap-2">
            <div class="flex min-w-0 items-center gap-1.5">
              <UiBadge variant="outline" class="shrink-0 text-[10px]">{{ rule.targetType === 'family' ? 'Family' : 'Model' }}</UiBadge>
              <span class="truncate font-mono text-xs">{{ rule.target }}</span>
            </div>
            <UiButton variant="ghost" size="sm" class="h-7 w-7 p-0 text-muted-foreground hover:text-destructive" :disabled="isSaving" @click="removeRule(index)">
              <UiIcon name="i-lucide-trash-2" class="size-3.5" />
            </UiButton>
          </div>
          <div class="mt-3 grid grid-cols-3 gap-2">
            <label class="text-[10px] text-muted-foreground">/ minute<input :value="rule.perMinute" placeholder="--" class="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" @input="updateRule(index, 'perMinute', ($event.target as HTMLInputElement).value)"></label>
            <label class="text-[10px] text-muted-foreground">/ hour<input :value="rule.perHour" placeholder="--" class="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" @input="updateRule(index, 'perHour', ($event.target as HTMLInputElement).value)"></label>
            <label class="text-[10px] text-muted-foreground">/ day<input :value="rule.perDay" placeholder="--" class="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" @input="updateRule(index, 'perDay', ($event.target as HTMLInputElement).value)"></label>
          </div>
        </div>
      </div>

      <div class="space-y-2 pt-1">
        <div class="flex items-center justify-between gap-2">
          <p class="text-xs font-medium">Add rule</p>
          <div class="grid grid-cols-2 gap-1 rounded-md border border-input bg-input/30 p-1">
            <button type="button" :class="['h-7 rounded-sm px-2 text-[11px] font-medium', addMode === 'model' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground']" @click="addMode = 'model'; pickerOpen = false">Model</button>
            <button type="button" :class="['h-7 rounded-sm px-2 text-[11px] font-medium', addMode === 'family' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground']" @click="addMode = 'family'; pickerOpen = false">Family</button>
          </div>
        </div>

        <UiPopover v-model:open="pickerOpen" :content="{ align: 'start', class: 'w-[min(90vw,28rem)] p-0' }">
          <UiButton variant="outline" class="h-9 w-full justify-between px-3 text-xs" :disabled="isSaving || pickerItems.length === 0">
            <span class="flex items-center gap-1.5 text-muted-foreground">
              <UiIcon name="i-lucide-plus" class="size-3.5" />
              {{ pickerItems.length === 0 ? `No ${addMode} left to add` : `Select ${addMode === 'model' ? 'model' : 'family'}` }}
            </span>
            <UiIcon name="i-lucide-chevron-down" class="size-3.5 text-muted-foreground" />
          </UiButton>
          <template #content>
            <div class="border-b border-border p-2">
              <input v-model="search" :placeholder="`Search ${addMode}...`" class="h-8 w-full rounded-md bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring">
            </div>
            <div class="max-h-72 overflow-y-auto p-1">
              <button v-for="item in pickerItems" :key="item" type="button" class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent" @click="addRule(item)">
                <span class="truncate font-mono text-[11px]">{{ item }}</span>
              </button>
              <p v-if="pickerItems.length === 0" class="px-2 py-6 text-center text-xs text-muted-foreground">No {{ addMode }} found.</p>
            </div>
          </template>
        </UiPopover>
      </div>
      <p v-if="errorMessage" class="text-xs text-destructive">{{ errorMessage }}</p>
    </div>

    <div class="flex items-center justify-end gap-2 border-t border-border/60 pt-3 lg:mt-4">
      <UiButton variant="outline" size="sm" :disabled="isSaving || !hasChanges" @click="resetDraft"><UiIcon name="i-lucide-rotate-ccw" class="size-3.5" />Reset</UiButton>
      <UiButton size="sm" :disabled="isSaving || !hasChanges" @click="save">{{ isSaving ? 'Saving...' : 'Save' }}</UiButton>
    </div>
  </section>
</template>
