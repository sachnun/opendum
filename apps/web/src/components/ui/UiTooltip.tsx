import type { ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { cn } from "../../lib/utils";

export interface UiTooltipProps {
  text: string;
  children: ReactNode;
  disabled?: boolean;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  alignOffset?: number;
  delayDuration?: number;
  className?: string;
}

export function UiTooltip({ text, children, disabled, side = "top", align = "center", sideOffset = 6, alignOffset = 0, delayDuration, className }: UiTooltipProps) {
  if (disabled || !text) return <>{children}</>;
  return (
    <Tooltip.Root delayDuration={delayDuration}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          alignOffset={alignOffset}
          className={cn(
            "z-50 overflow-hidden rounded-md border bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
            className,
          )}
        >
          {text}
          <Tooltip.Arrow className="fill-popover" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
