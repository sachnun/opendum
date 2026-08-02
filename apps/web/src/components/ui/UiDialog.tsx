import type { HTMLAttributes, ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "../../lib/utils";
import { UiIcon } from "./UiIcon";
import { UiButton } from "./UiButton";

export interface UiDialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  modal?: boolean;
  ui?: { overlay?: string; content?: string; close?: string };
  children: ReactNode;
}

export function UiDialog({ open, onOpenChange, modal, ui, children }: UiDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            ui?.overlay,
          )}
        />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex max-h-[85dvh] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-hidden rounded-lg border border-border bg-background p-6 text-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:max-w-lg",
            ui?.content,
          )}
        >
          {children}
          <Dialog.Close asChild>
            <UiButton
              size="icon-xs"
              variant="ghost"
              aria-label="Close"
              className={cn("absolute right-4 top-4 text-muted-foreground", ui?.close)}
            >
              <UiIcon name="i-lucide-x" className="size-3.5" />
            </UiButton>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function UiDialogTrigger({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Dialog.Trigger asChild>
      <span className={className}>{children}</span>
    </Dialog.Trigger>
  );
}

export function UiDialogClose({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Dialog.Close asChild>
      <span className={className}>{children}</span>
    </Dialog.Close>
  );
}

export function UiDialogTitle(props: HTMLAttributes<HTMLHeadingElement>) {
  return <Dialog.Title className="text-base font-semibold" {...props} />;
}

export function UiDialogDescription(props: HTMLAttributes<HTMLParagraphElement>) {
  return <Dialog.Description className="text-sm text-muted-foreground" {...props} />;
}
