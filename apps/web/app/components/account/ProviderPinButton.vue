<script setup lang="ts">
import { settle } from "~~/lib/settle";
import { cn } from "~~/lib/utils";

const props = defineProps<{
  providerKey: string;
  pinned: boolean;
  readonly?: boolean;
  class?: string | string[];
}>();

const emit = defineEmits<{
  toggled: [providerKey: string, pinned: boolean];
}>();

const api = useApi();
const invalidation = useInvalidate();
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
  const toggled = await settle(() => api.accounts.togglePinned({ providerKey: props.providerKey }));
  pending.value = false;
  if (!toggled.ok || !toggled.value.success) {
    localPinned.value = previous;
    return;
  }
  localPinned.value = toggled.value.data.pinned;
  invalidation.patchPinnedProvider(props.providerKey, toggled.value.data.pinned);
  emit("toggled", props.providerKey, toggled.value.data.pinned);
}
</script>

<template>
  <UiTooltip :text="localPinned ? 'Unpin' : 'Pin'" :disabled="readonly">
    <button
      type="button"
      :class="cn(
        'cursor-pointer rounded-md p-1 transition-colors disabled:cursor-default disabled:opacity-50',
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
