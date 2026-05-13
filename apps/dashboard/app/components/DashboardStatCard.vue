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
        <p class="mt-2 text-2xl font-bold tracking-tight tabular-nums transition-transform duration-200 sm:text-3xl">
          {{ value }}
        </p>
        <p v-if="hint" class="mt-1 text-xs text-muted-foreground">
          {{ hint }}
        </p>
      </div>
      <UiIcon v-if="icon" :name="icon" class="size-5 text-muted-foreground" />
    </div>

    <span
      v-if="delta"
      :key="deltaKey"
      :class="[
        'pointer-events-none absolute right-4 top-4 rounded-full border px-2 py-0.5 text-xs font-black tabular-nums shadow-lg animate-[stat-hit_900ms_cubic-bezier(0.16,1,0.3,1)_both]',
        deltaTone === 'negative'
          ? 'border-red-400/40 bg-red-500/15 text-red-500 shadow-red-500/20'
          : deltaTone === 'neutral'
            ? 'border-blue-400/40 bg-blue-500/15 text-blue-500 shadow-blue-500/20'
            : 'border-emerald-400/40 bg-emerald-500/15 text-emerald-500 shadow-emerald-500/20',
      ]"
    >
      {{ delta }}
    </span>
  </div>
</template>

<style>
@keyframes stat-hit {
  0% {
    opacity: 0;
    transform: translate3d(0, 10px, 0) scale(0.75) rotate(-8deg);
  }

  18% {
    opacity: 1;
    transform: translate3d(0, -4px, 0) scale(1.18) rotate(3deg);
  }

  45% {
    opacity: 1;
    transform: translate3d(0, -12px, 0) scale(1) rotate(0deg);
  }

  100% {
    opacity: 0;
    transform: translate3d(0, -34px, 0) scale(0.92) rotate(7deg);
  }
}
</style>
