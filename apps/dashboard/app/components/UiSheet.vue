<script setup lang="ts">
import type { StyleValue } from "vue";
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
    overlayStyle?: StyleValue;
    contentStyle?: StyleValue;
  }>(),
  {
    side: "right",
    modal: true,
    ui: () => ({}),
    overlayStyle: undefined,
    contentStyle: undefined,
  }
);

const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{
  "overlay-pointer-down": [event: PointerEvent];
  "overlay-pointer-move": [event: PointerEvent];
  "overlay-pointer-up": [event: PointerEvent];
  "overlay-pointer-cancel": [event: PointerEvent];
  "overlay-click": [event: MouseEvent];
  "content-pointer-down-outside": [event: Event];
}>();

const sideClasses: Record<SheetSide, string> = {
  top: "inset-x-0 top-0 h-auto border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
  right: "inset-y-0 right-0 h-full w-3/4 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm",
  bottom: "inset-x-0 bottom-0 h-auto border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
  left: "inset-y-0 left-0 h-full w-3/4 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm",
};

function handleOpenAutoFocus(event: Event) {
  event.preventDefault();
}
</script>

<template>
  <DialogRoot v-model:open="open" :modal="modal">
    <DialogPortal>
      <DialogOverlay
        :class="cn(
          'fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          props.ui.overlay,
        )"
        :style="props.overlayStyle"
        @pointerdown="emit('overlay-pointer-down', $event)"
        @pointermove="emit('overlay-pointer-move', $event)"
        @pointerup="emit('overlay-pointer-up', $event)"
        @pointercancel="emit('overlay-pointer-cancel', $event)"
        @click="emit('overlay-click', $event)"
      />
      <DialogContent
        :class="cn(
          'fixed z-50 gap-4 border-border bg-background text-foreground shadow-lg outline-none transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500 data-[state=open]:animate-in data-[state=closed]:animate-out',
          sideClasses[side],
          props.ui.content,
        )"
        :style="props.contentStyle"
        @open-auto-focus="handleOpenAutoFocus"
        @pointer-down-outside="emit('content-pointer-down-outside', $event)"
      >
        <slot name="content">
          <slot />
        </slot>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
