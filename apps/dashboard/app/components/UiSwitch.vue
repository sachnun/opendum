<script setup lang="ts">
import { SwitchRoot, SwitchThumb } from "reka-ui";
import { cn } from "../../lib/utils";

withDefaults(
  defineProps<{
    disabled?: boolean;
    size?: "sm" | "default";
    class?: string;
  }>(),
  {
    disabled: false,
    size: "default",
    class: "",
  }
);

const checked = defineModel<boolean>({ default: false });
</script>

<template>
  <SwitchRoot
    v-model="checked"
    :disabled="disabled"
    :data-size="size"
    :class="cn(
      'peer group/switch inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent shadow-xs outline-none transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-[1.15rem] data-[size=default]:w-8 data-[size=sm]:h-3.5 data-[size=sm]:w-6',
      checked ? 'bg-primary' : 'bg-input/80',
      $props.class,
    )"
  >
    <SwitchThumb
      :class="cn(
        'pointer-events-none block rounded-full ring-0 transition-transform group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3',
        checked ? 'translate-x-[calc(100%-2px)] bg-primary-foreground' : 'translate-x-0 bg-foreground',
      )"
    />
  </SwitchRoot>
</template>
