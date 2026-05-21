<script setup lang="ts">
import { PopoverArrow, PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import { cn } from "../../lib/utils";

type PopoverSide = "top" | "right" | "bottom" | "left";
type PopoverAlign = "start" | "center" | "end";

const props = withDefaults(
  defineProps<{
    content?: {
      align?: PopoverAlign;
      alignOffset?: number;
      side?: PopoverSide;
      sideOffset?: number;
      arrowClass?: string | string[];
      class?: string;
    };
    modal?: boolean;
    class?: string;
  }>(),
  {
    content: () => ({}),
    modal: false,
    class: "",
  }
);

const open = defineModel<boolean>("open", { default: false });
</script>

<template>
  <PopoverRoot v-model:open="open" :modal="modal">
    <PopoverTrigger as-child>
      <slot />
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        :align="content.align ?? 'center'"
        :align-offset="content.alignOffset"
        :side="content.side ?? 'bottom'"
        :side-offset="content.sideOffset ?? 8"
        :class="cn(
          'z-50 rounded-lg border border-border bg-background text-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
          content.class,
          props.class,
        )"
        >
        <slot name="content" />
        <PopoverArrow :class="cn('fill-background', content.arrowClass)" />
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
