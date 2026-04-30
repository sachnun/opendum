<script setup lang="ts">
import { DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogRoot } from "reka-ui";
import { cn } from "../../lib/utils";

const props = withDefaults(
  defineProps<{
    modal?: boolean;
    ui?: {
      overlay?: string;
      content?: string;
    };
    preventOutsideClose?: boolean;
    preventEscapeClose?: boolean;
    showClose?: boolean;
  }>(),
  {
    modal: true,
    ui: () => ({}),
    preventOutsideClose: false,
    preventEscapeClose: false,
    showClose: true,
  }
);

const open = defineModel<boolean>("open", { default: false });

function handleInteractOutside(event: Event) {
  if (props.preventOutsideClose) event.preventDefault();
}

function handleEscapeKeyDown(event: Event) {
  if (props.preventEscapeClose) event.preventDefault();
}
</script>

<template>
  <DialogRoot v-model:open="open" :modal="modal">
    <DialogPortal>
      <DialogOverlay
        :class="cn(
          'fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          ui.overlay,
        )"
      />
      <DialogContent
        :class="cn(
          'fixed left-1/2 top-1/2 z-50 flex max-h-[85dvh] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-hidden rounded-lg border border-border bg-background p-6 text-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:max-w-lg',
          props.ui.content,
        )"
        @interact-outside="handleInteractOutside"
        @escape-key-down="handleEscapeKeyDown"
      >
        <slot name="content">
          <slot />
        </slot>
        <DialogClose
          v-if="showClose"
          class="absolute right-4 top-4 cursor-pointer rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0"
        >
          <UiIcon name="i-lucide-x" class="size-4" />
          <span class="sr-only">Close</span>
        </DialogClose>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
