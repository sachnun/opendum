import type { JSX } from "solid-js";

type Placement = "top" | "right" | "bottom" | "left";
type Align = "start" | "center" | "end";

export function placement(side: Placement, align: Align): `${Placement}-${"start" | "end"}` | Placement {
  return align === "center" ? side : `${side}-${align}`;
}

export type TriggerRenderer = (childProps: JSX.HTMLAttributes<HTMLElement>) => JSX.Element;

export function asButtonProps(props: JSX.HTMLAttributes<HTMLElement>): JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  return props as unknown as JSX.ButtonHTMLAttributes<HTMLButtonElement>;
}

export function asSpanProps(props: JSX.HTMLAttributes<HTMLElement>): JSX.HTMLAttributes<HTMLSpanElement> {
  return props as unknown as JSX.HTMLAttributes<HTMLSpanElement>;
}
