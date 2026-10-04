<script setup lang="ts">
const props = defineProps<{
  error?: unknown;
}>();

const errorMessage = computed(() => {
  const error = props.error;

  if (!error) return "";
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;

  return "The dashboard could not load live data.";
});
</script>

<template>
  <div
    v-if="error"
    class="relative w-full rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
    role="alert"
  >
    <div class="flex gap-3">
      <UiIcon name="i-lucide-triangle-alert" class="mt-0.5 size-4 shrink-0 text-yellow-500" />
      <div>
        <p class="font-medium text-foreground">Unable to load live data</p>
        <p class="mt-1 text-muted-foreground">{{ errorMessage }}</p>
      </div>
    </div>
  </div>
</template>
