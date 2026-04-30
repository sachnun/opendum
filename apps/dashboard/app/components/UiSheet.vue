<script setup lang="ts">
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot } from "reka-ui";
import { cn } from "../../lib/utils";

type SheetSide = "top" | "right" | "bottom" | "left";

const props = withDefaults(
  defineProps<{
    side?: SheetSide;
    modal?: boolean;
    ui?: {
      overlay?: string;
      content?: string;
    };
  }>(),
  {
    side: "right",
    modal: true,
    ui: () => ({}),
  }
);

const open = defineModel<boolean>("open", { default: false });

const sideClasses: Record<SheetSide, string> = {
  top: "inset-x-0 top-0 h-auto border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
  right: "inset-y-0 right-0 h-full w-3/4 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm",
  bottom: "inset-x-0 bottom-0 h-auto border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
  left: "inset-y-0 left-0 h-full w-3/4 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm",
};
</script>

<template>
  <DialogRoot v-model:open="open" :modal="modal">
    <DialogPortal>
      <DialogOverlay
        :class="cn(
          'fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          props.ui.overlay,
        )"
      />
      <DialogContent
        :class="cn(
          'fixed z-50 gap-4 border-border bg-background text-foreground shadow-lg outline-none transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500 data-[state=open]:animate-in data-[state=closed]:animate-out',
          sideClasses[side],
          props.ui.content,
        )"
      >
        <slot name="content">
          <slot />
        </slot>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
