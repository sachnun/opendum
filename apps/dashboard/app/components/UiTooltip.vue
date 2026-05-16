<script setup lang="ts">
import { TooltipArrow, TooltipContent, TooltipPortal, TooltipRoot, TooltipTrigger } from "reka-ui";
import { cn } from "../../lib/utils";

type TooltipSide = "top" | "right" | "bottom" | "left";
type TooltipAlign = "start" | "center" | "end";

const props = withDefaults(
  defineProps<{
    text?: string;
    side?: TooltipSide;
    align?: TooltipAlign;
    sideOffset?: number;
    alignOffset?: number;
    delayDuration?: number;
    disabled?: boolean;
    arrow?: boolean;
    class?: string | string[];
    contentClass?: string | string[];
  }>(),
  {
    text: undefined,
    side: "top",
    align: "center",
    sideOffset: 6,
    alignOffset: 0,
    delayDuration: undefined,
    disabled: false,
    arrow: true,
    class: "",
    contentClass: "",
  }
);
</script>

<template>
  <slot v-if="disabled" />
  <TooltipRoot v-else :delay-duration="delayDuration">
    <TooltipTrigger as-child>
      <slot />
    </TooltipTrigger>
    <TooltipPortal>
      <TooltipContent
        :side="side"
        :align="align"
        :side-offset="sideOffset"
        :align-offset="alignOffset"
        :class="cn(
          'z-50 max-w-72 rounded-md border border-border bg-popover px-2 py-1.5 text-xs leading-snug text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1',
          contentClass,
          props.class,
        )"
      >
        <slot name="content">{{ text }}</slot>
        <TooltipArrow v-if="arrow" class="fill-popover" />
      </TooltipContent>
    </TooltipPortal>
  </TooltipRoot>
</template>
