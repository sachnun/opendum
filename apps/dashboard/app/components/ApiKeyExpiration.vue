<script setup lang="ts">
import { CalendarDate } from "@internationalized/date";
import { format } from "date-fns";
import type { DateValue } from "reka-ui";

const props = defineProps<{
  apiKeyId: string;
  initialExpiresAt: string | Date | null;
}>();

const emit = defineEmits<{
  updated: [];
}>();

const dashboardApi = useDashboardApi();
const open = ref(false);
const isSaving = ref(false);
const expiresAt = ref<Date | null>(props.initialExpiresAt ? new Date(props.initialExpiresAt) : null);
const draftDate = ref<DateValue | undefined>(toCalendarDate(expiresAt.value));
const errorMessage = ref("");

watch(open, (value) => {
  if (value) {
    draftDate.value = toCalendarDate(expiresAt.value);
    errorMessage.value = "";
  }
});

const isExpired = computed(() => expiresAt.value != null && expiresAt.value < new Date());
const displayText = computed(() => (expiresAt.value ? format(expiresAt.value, "MMM d, yyyy") : "No expiry"));

watch(
  () => props.initialExpiresAt,
  (value) => {
    expiresAt.value = value ? new Date(value) : null;
    if (!open.value) draftDate.value = toCalendarDate(expiresAt.value);
  }
);

function toCalendarDate(value: Date | null): DateValue | undefined {
  if (!value) return undefined;
  return new CalendarDate(value.getFullYear(), value.getMonth() + 1, value.getDate());
}

function toDateOnlyString(value: DateValue): string {
  return value.toString().slice(0, 10);
}

function toLocalDate(value: DateValue | undefined): Date | null {
  if (!value) return null;
  const [year, month, day] = toDateOnlyString(value).split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1);
}

function isPastOrToday(value: DateValue): boolean {
  return toDateOnlyString(value) <= format(new Date(), "yyyy-MM-dd");
}

async function saveExpiration(value: Date | null) {
  isSaving.value = true;
  errorMessage.value = "";
  try {
    const result = await dashboardApi.apiKeys.updateExpiration({ id: props.apiKeyId, expiresAt: value });
    if (!result.success) throw new Error(result.error);
    expiresAt.value = result.data.expiresAt ? new Date(result.data.expiresAt) : null;
    open.value = false;
    emit("updated");
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Failed to update expiration";
  } finally {
    isSaving.value = false;
  }
}
</script>

<template>
  <UiPopover v-model:open="open" :content="{ align: 'start', class: 'w-72 p-0' }">
    <button
      type="button"
      :class="[
        'inline-flex cursor-pointer items-center gap-1 text-sm transition-colors hover:text-primary disabled:pointer-events-none disabled:opacity-50',
        isExpired ? 'text-destructive' : 'text-muted-foreground',
      ]"
      :disabled="isSaving"
    >
      <UiIcon name="i-lucide-calendar" class="size-3" />
      <span>{{ displayText }}</span>
    </button>
    <template #content>
      <div class="space-y-3 p-3">
        <div class="space-y-1.5">
          <p class="text-xs font-medium text-muted-foreground">Expiration date</p>
          <UiCalendar v-model="draftDate" :is-date-disabled="isPastOrToday" class="border-0 p-0" />
        </div>
        <p v-if="errorMessage" class="text-xs text-destructive">{{ errorMessage }}</p>
        <div class="flex items-center justify-between gap-2 border-t pt-2">
          <UiButton variant="ghost" size="sm" class="h-7 gap-1 text-xs" :disabled="isSaving || !expiresAt" @click="saveExpiration(null)">
            <UiIcon name="i-lucide-x" class="size-3" />
            Remove expiration
          </UiButton>
          <UiButton size="sm" class="h-7 text-xs" :disabled="isSaving || !draftDate" @click="saveExpiration(toLocalDate(draftDate))">
            Save
          </UiButton>
        </div>
      </div>
    </template>
  </UiPopover>
</template>
