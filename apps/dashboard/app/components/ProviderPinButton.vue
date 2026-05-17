<script setup lang="ts">
import type { ProviderAccountKey } from "../../lib/provider-accounts";
import { cn } from "../../lib/utils";

const props = defineProps<{
  providerKey: ProviderAccountKey;
  pinned: boolean;
  readonly?: boolean;
  class?: string | string[];
}>();

const emit = defineEmits<{
  toggled: [providerKey: ProviderAccountKey, pinned: boolean];
}>();

const dashboardApi = useDashboardApi();
const dashboardInvalidation = useDashboardDataInvalidation();
const localPinned = ref(props.pinned);
const pending = ref(false);
const pinButtonLabel = computed(() => (localPinned.value ? "Unpin provider" : "Pin provider"));

watch(
  () => props.pinned,
  (value) => {
    localPinned.value = value;
  }
);

async function togglePin(event: Event) {
  event.preventDefault();
  event.stopPropagation();
  if (props.readonly) return;

  const previous = localPinned.value;
  localPinned.value = !previous;
  pending.value = true;
  try {
    const result = await dashboardApi.accounts.togglePinned({ providerKey: props.providerKey });
    if (!result.success) throw new Error(result.error);
    localPinned.value = result.data.pinned;
    dashboardInvalidation.patchPinnedProvider(props.providerKey, result.data.pinned);
    emit("toggled", props.providerKey, result.data.pinned);
  } catch {
    localPinned.value = previous;
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <UiTooltip :text="localPinned ? 'Unpin' : 'Pin'">
    <button
      type="button"
      :class="cn(
        'cursor-pointer rounded-md p-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        localPinned ? 'text-foreground hover:text-muted-foreground' : 'text-muted-foreground/40 hover:text-muted-foreground',
        props.class,
      )"
      :aria-label="pinButtonLabel"
      :aria-pressed="localPinned"
      :disabled="pending || readonly"
      @click="togglePin"
    >
      <UiIcon :name="localPinned ? 'i-lucide-pin' : 'i-lucide-pin-off'" class="size-4" />
    </button>
  </UiTooltip>
</template>
