<script setup lang="ts">
defineProps<{
  title: string;
  description?: string;
  icon?: string;
}>();
</script>

<template>
  <UCard>
    <div class="flex min-h-48 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <div class="rounded-full bg-muted p-4">
        <UIcon :name="icon ?? 'i-lucide-circle-dashed'" class="size-8 text-muted-foreground" />
      </div>
      <div class="space-y-1">
        <h2 class="text-base font-semibold">
          {{ title }}
        </h2>
        <p v-if="description" class="max-w-md text-sm text-muted-foreground">
          {{ description }}
        </p>
      </div>
      <div v-if="$slots.default" class="mt-2">
        <slot />
      </div>
    </div>
  </UCard>
</template>
