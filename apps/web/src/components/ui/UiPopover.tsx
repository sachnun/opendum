import { Popover } from "@ark-ui/solid/popover";
import type { JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { cn } from "~/lib/utils";
import { placement, type TriggerRenderer } from "~/components/ui/trigger";

type PopoverSide = "top" | "right" | "bottom" | "left";
type PopoverAlign = "start" | "center" | "end";

export interface UiPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger?: TriggerRenderer;
  children?: JSX.Element;
  content?: JSX.Element;
  contentClass?: string | string[];
  align?: PopoverAlign;
  alignOffset?: number;
  side?: PopoverSide;
  sideOffset?: number;
  arrowClass?: string | string[];
  modal?: boolean;
  class?: string | string[];
}

export function UiPopover(props: UiPopoverProps): JSX.Element {
  return (
    <Popover.Root
      open={props.open}
      onOpenChange={(details) => props.onOpenChange(details.open)}
      modal={props.modal ?? false}
      positioning={{
        placement: placement(props.side ?? "bottom", props.align ?? "center"),
        offset: { mainAxis: props.sideOffset ?? 8, crossAxis: props.alignOffset ?? 0 },
      }}
      lazyMount
      unmountOnExit
    >
      <Popover.Trigger asChild={(childProps) => props.trigger ? props.trigger(childProps()) : (props.children as JSX.Element)} />
      <Portal>
        <Popover.Positioner>
          <Popover.Content
            class={cn(
              "z-50 rounded-lg border border-border bg-background text-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
              props.contentClass,
              props.class
            )}
          >
            {props.content}
            <Popover.Arrow class={cn("fill-background", props.arrowClass)}>
              <Popover.ArrowTip />
            </Popover.Arrow>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}
