import type { JSX } from "solid-js";
import { cn } from "~/lib/utils";

export interface UiCardProps {
  class?: string | string[];
  id?: string;
  "data-model-id"?: string;
  "data-account-id"?: string;
  children?: JSX.Element;
}

export function UiCard(props: UiCardProps): JSX.Element {
  return (
    <div
      id={props.id}
      data-model-id={props["data-model-id"]}
      data-account-id={props["data-account-id"]}
      class={cn("flex flex-col gap-6 rounded-xl border bg-card py-6 text-card-foreground shadow-sm", props.class)}
    >
      {props.children}
    </div>
  );
}

export function UiCardHeader(props: UiCardProps): JSX.Element {
  return <div class={cn("grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6", props.class)}>{props.children}</div>;
}

export function UiCardTitle(props: UiCardProps): JSX.Element {
  return <div class={cn("font-semibold leading-none", props.class)}>{props.children}</div>;
}

export function UiCardContent(props: UiCardProps): JSX.Element {
  return <div class={cn("px-6", props.class)}>{props.children}</div>;
}
