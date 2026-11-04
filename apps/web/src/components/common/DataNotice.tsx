import { Show, type JSX } from "solid-js";
import { UiIcon } from "~/components/ui/UiIcon";

function messageOf(error: unknown): string {
  if (!error) return "";
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && "message" in error && typeof (error as { message: unknown }).message === "string") {
    return (error as { message: string }).message;
  }

  return "The web app could not load live data.";
}

export function DataNotice(props: { error?: unknown }): JSX.Element {
  return (
    <Show when={props.error}>
      <div class="relative w-full rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground" role="alert">
        <div class="flex gap-3">
          <UiIcon name="i-lucide-triangle-alert" class="mt-0.5 size-4 shrink-0 text-yellow-500" />
          <div>
            <p class="font-medium text-foreground">Unable to load live data</p>
            <p class="mt-1 text-muted-foreground">{messageOf(props.error)}</p>
          </div>
        </div>
      </div>
    </Show>
  );
}
