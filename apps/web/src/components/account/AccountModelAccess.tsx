import { For, Show, createEffect, createSignal, on, type JSX } from "solid-js";
import { compareIds } from "@opendum/models/sort";
import type { AccountHealthItem } from "~/lib/api-types";
import { api } from "~/api";
import { invalidation } from "~/lib/invalidate";
import { settle } from "~/lib/settle";
import { UiTooltip } from "~/components/ui/UiTooltip";

export interface AccountModelAccessProps {
  accountId: string;
  provider: string;
  supportedModels: string[];
  initialDisabledModels: string[];
  modelHealth: Record<string, AccountHealthItem>;
  activeModel?: string | null;
  readonly?: boolean;
}

const VISIBLE_COUNT = 5;

export function AccountModelAccess(props: AccountModelAccessProps): JSX.Element {
  const [disabledModels, setDisabledModels] = createSignal(new Set(props.initialDisabledModels));
  const [togglingModels, setTogglingModels] = createSignal(new Set<string>());
  const [expanded, setExpanded] = createSignal(false);

  createEffect(
    on(
      () => props.initialDisabledModels,
      (models) => setDisabledModels(new Set(models))
    )
  );

  const enabledCount = () => props.supportedModels.length - disabledModels().size;
  const hasMore = () => props.supportedModels.length > VISIBLE_COUNT;
  const sortedModels = () =>
    [...props.supportedModels].sort((a, b) => sortWeight(a) - sortWeight(b) || compareIds(a, b));
  const visibleModels = () => (expanded() ? sortedModels() : sortedModels().slice(0, VISIBLE_COUNT));
  const hiddenCount = () => props.supportedModels.length - VISIBLE_COUNT;

  function sortWeight(model: string): number {
    const status = props.modelHealth[model]?.status;
    if (status === "degraded") return 0;
    return 1;
  }

  function buttonClass(model: string): string {
    if (disabledModels().has(model)) return "border border-border/60 bg-transparent text-muted-foreground/60 line-through";
    if (props.activeModel === model) return "border border-green-500 bg-green-500/10 text-green-700";
    const status = props.modelHealth[model]?.status;
    if (status === "degraded") return "border border-yellow-500/45 bg-transparent text-yellow-700";
    return "border border-border bg-transparent text-foreground hover:bg-muted/30";
  }

  function buttonTitle(model: string): string {
    if (props.activeModel === model) return "Active session";
    return disabledModels().has(model) ? "Enable" : "Disable";
  }

  async function toggleModel(model: string) {
    if (props.readonly) return;
    const currentlyEnabled = !disabledModels().has(model);
    const enabled = !currentlyEnabled;
    const previous = new Set(disabledModels());
    const next = new Set(disabledModels());

    if (enabled) next.delete(model);
    else next.add(model);

    setDisabledModels(next);
    setTogglingModels(new Set(togglingModels()).add(model));

    const toggled = await settle(() => api.accounts.enableModel({ accountId: props.accountId, modelId: model, enabled }));
    if (toggled.ok && toggled.value.success) {
      invalidation.patchDisabledModels(props.provider, props.accountId, Array.from(disabledModels()));
      invalidation.clearOptions();
    } else {
      setDisabledModels(previous);
    }
    const pending = new Set(togglingModels());
    pending.delete(model);
    setTogglingModels(pending);
  }

  return (
    <Show when={props.supportedModels.length > 0}>
      <div class="mt-3 space-y-2 border-t pt-3">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-medium text-muted-foreground">Model Access</span>
          <span class="text-xs text-muted-foreground">
            {enabledCount()}/{props.supportedModels.length}
          </span>
        </div>
        <div class="flex flex-wrap gap-1.5">
          <For each={visibleModels()}>
            {(model) => (
              <UiTooltip text={buttonTitle(model)} disabled={props.readonly}>
                <button
                  type="button"
                  disabled={togglingModels().has(model) || props.readonly}
                  class={`inline-flex cursor-pointer items-center rounded-md px-2 py-0.5 font-mono text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50 ${buttonClass(model)}`}
                  onClick={() => void toggleModel(model)}
                >
                  {model}
                </button>
              </UiTooltip>
            )}
          </For>
          <Show when={hasMore()}>
            <button
              type="button"
              class="inline-flex cursor-pointer items-center rounded-md border border-border bg-transparent px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setExpanded(!expanded())}
            >
              {expanded() ? "Show less" : `+${hiddenCount()} more`}
            </button>
          </Show>
        </div>
      </div>
    </Show>
  );
}
