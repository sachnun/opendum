import { Show, type JSX } from "solid-js";
import { capabilitiesOf, type ModelCapabilitiesInput } from "~/lib/model-capabilities";
import { UiBadge } from "~/components/ui/UiBadge";
import { UiIcon } from "~/components/ui/UiIcon";

export function ModelFeatureBadges(props: { model?: ModelCapabilitiesInput }): JSX.Element {
  const capabilities = () => capabilitiesOf(props.model);

  return (
    <div class="space-y-1.5 text-xs text-muted-foreground">
      <Show when={capabilities().reasoning || capabilities().vision}>
        <div class="flex flex-wrap gap-1">
          <Show when={capabilities().reasoning}>
            <UiBadge variant="outline" class="h-5 py-0 text-[11px]">
              <UiIcon name="i-lucide-brain" class="mr-1 size-3" /> Reasoning
            </UiBadge>
          </Show>
          <Show when={capabilities().vision}>
            <UiBadge variant="outline" class="h-5 py-0 text-[11px]">
              <UiIcon name="i-lucide-eye" class="mr-1 size-3" /> Vision
            </UiBadge>
          </Show>
        </div>
      </Show>
    </div>
  );
}
