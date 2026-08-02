import * as Switch from "@radix-ui/react-switch";
import { cn } from "../../lib/utils";
import { UiTooltip } from "./UiTooltip";

export interface UiSwitchProps {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  size?: "sm" | "default";
  className?: string;
  title?: string;
}

export function UiSwitch({ checked, onCheckedChange, disabled, size = "default", className, title }: UiSwitchProps) {
  const sw = (
    <Switch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      data-size={size}
      className={cn(
        "peer group/switch inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent shadow-xs outline-none transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-50 data-[size=default]:h-[1.15rem] data-[size=default]:w-8 data-[size=sm]:h-3.5 data-[size=sm]:w-6",
        checked ? "bg-primary" : "bg-input/80",
        className,
      )}
    >
      <Switch.Thumb
        className={cn(
          "pointer-events-none block rounded-full ring-0 transition-transform group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3",
          checked ? "translate-x-[calc(100%-2px)] bg-primary-foreground" : "translate-x-0 bg-foreground",
        )}
      />
    </Switch.Root>
  );
  if (title && !disabled) {
    return <UiTooltip text={title}>{sw}</UiTooltip>;
  }
  return sw;
}
