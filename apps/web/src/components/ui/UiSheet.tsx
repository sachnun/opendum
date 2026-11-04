import { Dialog } from "@ark-ui/solid/dialog";
import type { JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { cn } from "~/lib/utils";

type SheetSide = "top" | "right" | "bottom" | "left";

export interface UiSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: SheetSide;
  modal?: boolean;
  ui?: {
    overlay?: string;
    content?: string;
  };
  overlayStyle?: JSX.CSSProperties;
  contentStyle?: JSX.CSSProperties;
  content?: JSX.Element;
  children?: JSX.Element;
  onOverlayClick?: (event: MouseEvent) => void;
  onOverlayPointerDown?: (event: PointerEvent) => void;
  onOverlayPointerMove?: (event: PointerEvent) => void;
  onOverlayPointerUp?: (event: PointerEvent) => void;
  onOverlayPointerCancel?: (event: PointerEvent) => void;
  onContentPointerDownOutside?: (event: Event) => void;
}

const sideClasses: Record<SheetSide, string> = {
  top: "inset-x-0 top-0 h-auto border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
  right:
    "inset-y-0 right-0 h-full w-3/4 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm",
  bottom:
    "inset-x-0 bottom-0 h-auto border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
  left: "inset-y-0 left-0 h-full w-3/4 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm",
};

export function UiSheet(props: UiSheetProps): JSX.Element {
  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(details) => props.onOpenChange(details.open)}
      modal={props.modal ?? true}
      lazyMount
      unmountOnExit
    >
      <Portal>
        <Dialog.Backdrop
          class={cn(
            "fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            props.ui?.overlay
          )}
          style={props.overlayStyle}
          onPointerDown={(event) => props.onOverlayPointerDown?.(event)}
          onPointerMove={(event) => props.onOverlayPointerMove?.(event)}
          onPointerUp={(event) => props.onOverlayPointerUp?.(event)}
          onPointerCancel={(event) => props.onOverlayPointerCancel?.(event)}
          onClick={(event) => props.onOverlayClick?.(event)}
        />
        <Dialog.Positioner>
          <Dialog.Content
            class={cn(
              "fixed z-50 gap-4 border-border bg-background text-foreground shadow-lg outline-none transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500 data-[state=open]:animate-in data-[state=closed]:animate-out",
              sideClasses[props.side ?? "right"],
              props.ui?.content
            )}
            style={props.contentStyle}
          >
            {props.content ?? props.children}
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
