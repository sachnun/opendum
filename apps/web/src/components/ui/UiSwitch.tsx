import { Switch } from "@ark-ui/solid/switch";
import type { JSX } from "solid-js";
import { cn } from "~/lib/utils";
import { UiTooltip } from "~/components/ui/UiTooltip";

export interface UiSwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  size?: "sm" | "default";
  class?: string | string[];
  title?: string;
  onPointerDown?: (event: PointerEvent) => void;
  onPointerUp?: (event: PointerEvent) => void;
  onPointerLeave?: (event: PointerEvent) => void;
  onPointerCancel?: (event: PointerEvent) => void;
  onClickCapture?: (event: MouseEvent) => void;
}

export function UiSwitch(props: UiSwitchProps): JSX.Element {
  return (
    <UiTooltip text={props.title} disabled={!props.title || props.disabled}>
      <Switch.Root
        checked={props.checked}
        onCheckedChange={(details) => props.onCheckedChange(details.checked)}
        disabled={props.disabled}
        data-size={props.size ?? "default"}
        class={cn(
          "peer group/switch inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent shadow-xs outline-none transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input/80 data-[size=default]:h-[1.15rem] data-[size=default]:w-8 data-[size=sm]:h-3.5 data-[size=sm]:w-6",
          props.class
        )}
        onClick={(event) => props.onClickCapture?.(event)}
        onPointerDown={(event) => props.onPointerDown?.(event)}
        onPointerUp={(event) => props.onPointerUp?.(event)}
        onPointerLeave={(event) => props.onPointerLeave?.(event)}
        onPointerCancel={(event) => props.onPointerCancel?.(event)}
      >
        <Switch.Control>
          <Switch.Thumb
            class={cn(
              "pointer-events-none block rounded-full ring-0 transition-transform group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3",
              props.checked
                ? "translate-x-[calc(100%-2px)] bg-primary-foreground"
                : "translate-x-0 bg-foreground"
            )}
          />
        </Switch.Control>
        <Switch.HiddenInput />
      </Switch.Root>
    </UiTooltip>
  );
}
