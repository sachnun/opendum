<script setup lang="ts">
defineProps<{
  label: string;
  value: string | number;
  hint?: string;
  icon?: string;
  delta?: string;
  deltaKey?: string | number;
  deltaTone?: "positive" | "negative" | "neutral";
}>();
</script>

<template>
  <div class="relative overflow-hidden rounded-xl border border-border bg-muted/40 px-4 py-4 sm:px-5">
    <div class="flex items-start justify-between gap-4">
      <div class="min-w-0">
        <p class="text-xs font-medium text-muted-foreground">
          {{ label }}
        </p>
        <div class="mt-2 flex items-baseline gap-2">
          <p class="text-2xl font-bold tracking-tight tabular-nums transition-transform duration-200 sm:text-3xl">
            {{ value }}
          </p>
          <span
            v-if="delta"
            :key="deltaKey"
            :class="[
              'pointer-events-none text-xs font-black tabular-nums animate-[stat-hit_1800ms_ease-in-out_both]',
              deltaTone === 'negative'
                ? 'text-red-500'
                : deltaTone === 'neutral'
                  ? 'text-blue-500'
                  : 'text-emerald-500',
            ]"
          >
            {{ delta }}
          </span>
        </div>
        <p v-if="hint" class="mt-1 text-xs text-muted-foreground">
          {{ hint }}
        </p>
      </div>
      <UiIcon v-if="icon" :name="icon" class="size-5 text-muted-foreground" />
    </div>
  </div>
</template>

<style>
@keyframes stat-hit {
  0% {
    opacity: 0;
    transform: translate3d(0, 2px, 0);
  }

  25% {
    opacity: 1;
    transform: translate3d(0, 0, 0);
  }

  70% {
    opacity: 1;
    transform: translate3d(0, 0, 0);
  }

  100% {
    opacity: 0;
    transform: translate3d(0, -2px, 0);
  }
}
</style>
