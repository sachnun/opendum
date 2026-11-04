import { Dialog } from "@ark-ui/solid/dialog";
import { Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { cn } from "~/lib/utils";
import { UiIcon } from "~/components/ui/UiIcon";

export interface UiDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  modal?: boolean;
  preventOutsideClose?: boolean;
  preventEscapeClose?: boolean;
  preventCloseAutoFocus?: boolean;
  showClose?: boolean;
  ui?: {
    overlay?: string;
    content?: string;
    close?: string;
  };
  children?: JSX.Element;
  content?: JSX.Element;
}

export function UiDialog(props: UiDialogProps): JSX.Element {
  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(details) => props.onOpenChange(details.open)}
      modal={props.modal ?? true}
      closeOnInteractOutside={!(props.preventOutsideClose ?? false)}
      closeOnEscape={!(props.preventEscapeClose ?? false)}
      lazyMount
      unmountOnExit
    >
      <Portal>
        <Dialog.Backdrop
          class={cn(
            "fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            props.ui?.overlay
          )}
        />
        <Dialog.Positioner>
          <Dialog.Content
            class={cn(
              "fixed left-1/2 top-1/2 z-50 flex max-h-[85dvh] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-hidden rounded-lg border border-border bg-background p-6 text-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:max-w-lg",
              props.ui?.content
            )}
          >
            {props.content ?? props.children}
            <Show when={props.showClose ?? true}>
              <Dialog.CloseTrigger
                class={cn(
                  "absolute right-4 top-4 cursor-pointer rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:outline-none disabled:cursor-default disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0",
                  props.ui?.close
                )}
              >
                <UiIcon name="i-lucide-x" class="size-4" />
                <span class="sr-only">Close</span>
              </Dialog.CloseTrigger>
            </Show>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
