import { Show, type JSX } from "solid-js";
import { UiBadge } from "~/components/ui/UiBadge";
import { UiIcon } from "~/components/ui/UiIcon";

export interface ApiKeyAccessSectionProps {
  title: string;
  badge?: string;
  defaultOpen?: boolean;
  children?: JSX.Element;
}

export function ApiKeyAccessSection(props: ApiKeyAccessSectionProps): JSX.Element {
  return (
    <details open={props.defaultOpen ?? false} class="rounded-sm border border-border/60 bg-muted/20">
      <summary class="flex w-full cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-left text-sm font-semibold [&::-webkit-details-marker]:hidden">
        <span class="flex min-w-0 items-center gap-2">
          <span class="truncate">{props.title}</span>
          <Show when={props.badge}>
            <UiBadge variant="outline" class="text-[10px] font-normal">
              {props.badge}
            </UiBadge>
          </Show>
        </span>
        <UiIcon name="i-lucide-chevron-down" class="size-4 text-muted-foreground transition-transform" />
      </summary>
      <div class="px-3 pb-3">{props.children}</div>
    </details>
  );
}
