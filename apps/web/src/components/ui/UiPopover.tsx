import type { ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { cn } from "../../lib/utils";

export interface UiPopoverProps {
  trigger: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  modal?: boolean;
  content?: {
    align?: "start" | "center" | "end";
    alignOffset?: number;
    side?: "top" | "right" | "bottom" | "left";
    sideOffset?: number;
    className?: string;
    arrowClass?: string;
  };
  className?: string;
}

export function UiPopover({ trigger, children, open, onOpenChange, modal, content, className }: UiPopoverProps) {
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align={content?.align ?? "center"}
          alignOffset={content?.alignOffset}
          side={content?.side ?? "bottom"}
          sideOffset={content?.sideOffset ?? 8}
          className={cn(
            "z-50 rounded-lg border border-border bg-background text-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
            content?.className,
            className,
          )}
        >
          {children}
          <Popover.Arrow className={cn("fill-background", content?.arrowClass)} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
