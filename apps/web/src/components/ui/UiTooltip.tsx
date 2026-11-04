import { Tooltip } from "@ark-ui/solid/tooltip";
import type { JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { cn } from "~/lib/utils";
import { placement, type TriggerRenderer } from "~/components/ui/trigger";

type TooltipSide = "top" | "right" | "bottom" | "left";
type TooltipAlign = "start" | "center" | "end";

export interface UiTooltipProps {
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
  trigger?: TriggerRenderer;
  content?: JSX.Element;
  children?: JSX.Element;
}

export function UiTooltip(props: UiTooltipProps): JSX.Element {
  const body = () => props.content ?? props.text;

  return (
    <>
      {props.disabled ? (
        (props.trigger ?? props.children)
      ) : (
        <Tooltip.Root
          openDelay={props.delayDuration}
          closeDelay={0}
          positioning={{
            placement: placement(props.side ?? "top", props.align ?? "center"),
            offset: { mainAxis: props.sideOffset ?? 6, crossAxis: props.alignOffset ?? 0 },
          }}
          lazyMount
          unmountOnExit
        >
          <Tooltip.Trigger asChild={(childProps) => props.trigger ? props.trigger(childProps()) : (props.children as JSX.Element)} />
          <Portal>
            <Tooltip.Positioner>
              <Tooltip.Content
                class={cn(
                  "z-50 max-w-72 rounded-md border border-border bg-background px-2 py-1.5 text-xs leading-snug text-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1 [@media(hover:none)]:hidden [@media(pointer:coarse)]:hidden",
                  props.contentClass,
                  props.class
                )}
              >
                {body()}
                {(props.arrow ?? true) && (
                  <Tooltip.Arrow class="fill-background">
                    <Tooltip.ArrowTip />
                  </Tooltip.Arrow>
                )}
              </Tooltip.Content>
            </Tooltip.Positioner>
          </Portal>
        </Tooltip.Root>
      )}
    </>
  );
}
