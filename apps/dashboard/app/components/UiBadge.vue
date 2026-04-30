<script setup lang="ts">
import { cn } from "../../lib/utils";

withDefaults(
  defineProps<{
    variant?: "default" | "secondary" | "destructive" | "outline" | "ghost" | "link";
    class?: string;
  }>(),
  {
    variant: "default",
    class: "",
  }
);

const variantClasses = {
  default: "bg-primary text-primary-foreground",
  secondary: "bg-secondary text-secondary-foreground",
  destructive: "bg-destructive/60 text-white",
  outline: "border-border text-foreground",
  ghost: "",
  link: "text-primary underline-offset-4",
};
</script>

<template>
  <span
    :class="cn(
      'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-full border border-transparent px-2 py-0.5 text-xs font-medium transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 [&>svg]:size-3',
      variantClasses[variant],
      $props.class,
    )"
  >
    <slot />
  </span>
</template>
