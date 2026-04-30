<script setup lang="ts">
import type { ProviderAccountKey } from "../../lib/provider-accounts";
import { cn } from "../../lib/utils";

const props = defineProps<{
  providerKey: ProviderAccountKey;
  pinned: boolean;
}>();

const emit = defineEmits<{
  toggled: [providerKey: ProviderAccountKey, pinned: boolean];
}>();

const { $client } = useNuxtApp();
const localPinned = ref(props.pinned);
const pending = ref(false);

watch(
  () => props.pinned,
  (value) => {
    localPinned.value = value;
  }
);

async function togglePin(event: Event) {
  event.preventDefault();
  event.stopPropagation();

  const previous = localPinned.value;
  localPinned.value = !previous;
  pending.value = true;
  try {
    const result = await $client.accounts.togglePinned.mutate({ providerKey: props.providerKey });
    if (!result.success) throw new Error(result.error);
    localPinned.value = result.data.pinned;
    emit("toggled", props.providerKey, result.data.pinned);
    void refreshNuxtData("dashboard-shell-accounts");
  } catch {
    localPinned.value = previous;
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <button
    type="button"
    :class="cn(
      'cursor-pointer rounded-md p-1 transition-colors disabled:pointer-events-none disabled:opacity-50',
      localPinned ? 'text-foreground hover:text-muted-foreground' : 'text-muted-foreground/40 hover:text-muted-foreground',
    )"
    :disabled="pending"
    :title="localPinned ? 'Unpin from sidebar' : 'Pin to sidebar'"
    @click="togglePin"
  >
    <UiIcon :name="localPinned ? 'i-lucide-pin' : 'i-lucide-pin-off'" class="size-4" />
  </button>
</template>
