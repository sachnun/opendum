<script setup lang="ts">
import { CalendarDate, Time } from "@internationalized/date";
import { format, isSameDay } from "date-fns";
import { TimeFieldInput, TimeFieldRoot } from "reka-ui";
import type { DateValue } from "reka-ui";

const props = defineProps<{
  apiKeyId: string;
  initialExpiresAt: string | Date | null;
  readonly?: boolean;
}>();

const emit = defineEmits<{
  updated: [value: { expiresAt: string | Date | null }];
}>();

const dashboardApi = useDashboardApi();
const open = ref(false);
const isSaving = ref(false);
const expiresAt = ref<Date | null>(props.initialExpiresAt ? new Date(props.initialExpiresAt) : null);
const draftDate = ref<DateValue | undefined>(toCalendarDate(expiresAt.value));
const draftTime = ref<Time>(toTimeValue(expiresAt.value));
const errorMessage = ref("");

watch(open, (value) => {
  if (value) {
    draftDate.value = toCalendarDate(expiresAt.value);
    draftTime.value = toTimeValue(expiresAt.value);
    errorMessage.value = "";
  }
});

const isExpired = computed(() => expiresAt.value != null && expiresAt.value < new Date());
const displayText = computed(() => (expiresAt.value ? format(expiresAt.value, "MMM d, yyyy HH:mm") : "No expiry"));
const draftExpiresAt = computed(() => toLocalDateTime(draftDate.value, draftTime.value));
const isDraftInPast = computed(() => {
  if (!draftExpiresAt.value) return false;
  return draftExpiresAt.value <= new Date();
});

watch(
  () => props.initialExpiresAt,
  (value) => {
    expiresAt.value = value ? new Date(value) : null;
    if (!open.value) {
      draftDate.value = toCalendarDate(expiresAt.value);
      draftTime.value = toTimeValue(expiresAt.value);
    }
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

function toTimeValue(value: Date | null): Time {
  return value ? new Time(value.getHours(), value.getMinutes()) : new Time(23, 59);
}

function toLocalDateTime(dateValue: DateValue | undefined, timeValue: Time): Date | null {
  const date = toLocalDate(dateValue);
  if (!date) return null;
  date.setHours(timeValue.hour, timeValue.minute, 0, 0);
  return date;
}

function isPastDate(value: DateValue): boolean {
  return toDateOnlyString(value) < format(new Date(), "yyyy-MM-dd");
}

function saveDraftExpiration() {
  const value = draftExpiresAt.value;
  if (!value) return;

  if (value <= new Date()) {
    errorMessage.value = isSameDay(value, new Date()) ? "Choose a future time." : "Choose a future expiration.";
    return;
  }

  saveExpiration(value);
}

async function saveExpiration(value: Date | null) {
  if (props.readonly) return;
  isSaving.value = true;
  errorMessage.value = "";
  try {
    const result = await dashboardApi.apiKeys.updateExpiration({ id: props.apiKeyId, expiresAt: value });
    if (!result.success) throw new Error(result.error);
    expiresAt.value = result.data.expiresAt ? new Date(result.data.expiresAt) : null;
    open.value = false;
    emit("updated", { expiresAt: result.data.expiresAt });
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
        'inline-flex cursor-pointer items-center gap-1 text-sm transition-colors hover:text-primary disabled:cursor-default disabled:pointer-events-none disabled:opacity-50',
        isExpired ? 'text-destructive' : 'text-muted-foreground',
      ]"
      :disabled="isSaving || readonly"
    >
      <UiIcon name="i-lucide-calendar" class="size-3" />
      <span>{{ displayText }}</span>
    </button>
    <template #content>
      <div class="space-y-3 p-3">
        <div class="space-y-1.5">
          <p class="text-xs font-medium text-muted-foreground">Expiration date</p>
          <UiCalendar v-model="draftDate" :is-date-disabled="isPastDate" class="border-0 p-0" />
        </div>
        <div class="space-y-1.5">
          <p class="text-xs font-medium text-muted-foreground">Expiration time</p>
          <TimeFieldRoot
            v-slot="{ segments }"
            v-model="draftTime"
            granularity="minute"
            :hour-cycle="24"
            class="inline-flex h-9 items-center rounded-md border border-input bg-background px-3 text-sm outline-none focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50"
          >
            <template v-for="segment in segments" :key="segment.part">
              <TimeFieldInput
                v-if="segment.part === 'literal'"
                :part="segment.part"
                class="px-0.5 text-muted-foreground"
              >
                {{ segment.value }}
              </TimeFieldInput>
              <TimeFieldInput
                v-else
                :part="segment.part"
                class="rounded px-0.5 tabular-nums outline-none focus:bg-accent focus:text-accent-foreground"
              >
                {{ segment.value }}
              </TimeFieldInput>
            </template>
          </TimeFieldRoot>
        </div>
        <p v-if="errorMessage" class="text-xs text-destructive">{{ errorMessage }}</p>
        <div class="flex items-center justify-between gap-2 border-t pt-2">
          <UiButton variant="ghost" size="sm" class="h-7 gap-1 text-xs" :disabled="isSaving || !expiresAt" @click="saveExpiration(null)">
            <UiIcon name="i-lucide-x" class="size-3" />
            Remove expiration
          </UiButton>
          <UiButton size="sm" class="h-7 text-xs" :disabled="isSaving || !draftDate || isDraftInPast" @click="saveDraftExpiration">
            Save
          </UiButton>
        </div>
      </div>
    </template>
  </UiPopover>
</template>
