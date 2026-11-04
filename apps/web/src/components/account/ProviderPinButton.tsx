import { createEffect, createSignal, on, type JSX } from "solid-js";
import { api } from "~/api";
import { invalidation } from "~/lib/invalidate";
import { settle } from "~/lib/settle";
import { cn } from "~/lib/utils";
import { UiIcon } from "~/components/ui/UiIcon";
import { UiTooltip } from "~/components/ui/UiTooltip";

export interface ProviderPinButtonProps {
  providerKey: string;
  pinned: boolean;
  readonly?: boolean;
  class?: string | string[];
  onToggled?: (providerKey: string, pinned: boolean) => void;
}

export function ProviderPinButton(props: ProviderPinButtonProps): JSX.Element {
  const [localPinned, setLocalPinned] = createSignal(props.pinned);
  const [pending, setPending] = createSignal(false);
  const pinButtonLabel = () => (localPinned() ? "Unpin provider" : "Pin provider");

  createEffect(
    on(
      () => props.pinned,
      (value) => setLocalPinned(value)
    )
  );

  async function togglePin(event: Event) {
    event.preventDefault();
    event.stopPropagation();
    if (props.readonly) return;

    const previous = localPinned();
    setLocalPinned(!previous);
    setPending(true);
    const toggled = await settle(() => api.accounts.togglePinned({ providerKey: props.providerKey }));
    setPending(false);
    if (!toggled.ok || !toggled.value.success) {
      setLocalPinned(previous);
      return;
    }
    setLocalPinned(toggled.value.data.pinned);
    invalidation.patchPinnedProvider(props.providerKey, toggled.value.data.pinned);
    props.onToggled?.(props.providerKey, toggled.value.data.pinned);
  }

  return (
    <UiTooltip text={localPinned() ? "Unpin" : "Pin"} disabled={props.readonly}>
      <button
        type="button"
        class={cn(
          "cursor-pointer rounded-md p-1 transition-colors disabled:cursor-default disabled:opacity-50",
          localPinned() ? "text-foreground hover:text-muted-foreground" : "text-muted-foreground/40 hover:text-muted-foreground",
          props.class
        )}
        aria-label={pinButtonLabel()}
        aria-pressed={localPinned()}
        disabled={pending() || props.readonly}
        onClick={togglePin}
      >
        <UiIcon name={localPinned() ? "i-lucide-pin" : "i-lucide-pin-off"} class="size-4" />
      </button>
    </UiTooltip>
  );
}
