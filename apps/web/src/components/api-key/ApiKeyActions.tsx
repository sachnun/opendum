import { Show, createSignal, onCleanup, type JSX } from "solid-js";
import type { KeyListItem } from "~/lib/api-types";
import { api } from "~/api";
import { errorText, raise, settle } from "~/lib/settle";
import { cn } from "~/lib/utils";
import { EditableApiKeyName } from "~/components/api-key/EditableApiKeyName";
import { UiButton } from "~/components/ui/UiButton";
import { UiDialog } from "~/components/ui/UiDialog";
import { UiIcon } from "~/components/ui/UiIcon";
import { UiTooltip } from "~/components/ui/UiTooltip";

export interface ApiKeyActionsProps {
  apiKey: KeyListItem;
  readonly?: boolean;
  pointsBalance?: number;
  onDeleted: (apiKeyId: string) => void;
  onRenamed: (value: { name: string | null; keyPreview?: string }) => void;
  onRefreshMe?: () => void;
}

export function ApiKeyActions(props: ApiKeyActionsProps): JSX.Element {
  const [isDeleting, setIsDeleting] = createSignal(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = createSignal(false);
  const [isRevealed, setIsRevealed] = createSignal(false);
  const [isTemporarilyRevealed, setIsTemporarilyRevealed] = createSignal(false);
  const [revealedKey, setRevealedKey] = createSignal<string | null>(null);
  const [isLoading, setIsLoading] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal("");
  let copyTimeout: ReturnType<typeof setTimeout> | null = null;

  const isKeyVisible = () => (isRevealed() || isTemporarilyRevealed()) && Boolean(revealedKey());
  const displayKey = () => (isKeyVisible() && revealedKey() ? revealedKey() : props.apiKey.keyPreview);

  async function revealKey() {
    if (props.readonly) return;
    if (isRevealed()) {
      setIsRevealed(false);
      setIsTemporarilyRevealed(false);
      setRevealedKey(null);
      return;
    }

    if (isTemporarilyRevealed()) {
      setIsTemporarilyRevealed(false);
      setRevealedKey(null);
      return;
    }

    if (revealedKey()) {
      setIsTemporarilyRevealed(false);
      setIsRevealed(true);
      return;
    }

    setIsLoading(true);
    setErrorMessage("");
    const revealed = await settle(() => api.apiKeys.reveal({ id: props.apiKey.id }));
    setIsLoading(false);
    if (!revealed.ok) {
      setErrorMessage(errorText(revealed.error, "Failed to reveal API key"));
      return;
    }
    if (!revealed.value.success) {
      setErrorMessage(revealed.value.error);
      return;
    }
    setRevealedKey(revealed.value.data.key);
    setIsRevealed(true);
  }

  async function copyKey() {
    if (props.readonly) return;
    let key = revealedKey();
    setIsLoading(true);
    setErrorMessage("");
    const copiedKey = await settle(async () => {
      if (!key) {
        const result = await api.apiKeys.reveal({ id: props.apiKey.id });
        if (!result.success) return raise(new Error(result.error));
        key = result.data.key;
      }
      await navigator.clipboard.writeText(key as string);
      return key as string;
    });
    setIsLoading(false);
    if (!copiedKey.ok) {
      setErrorMessage(errorText(copiedKey.error, "Failed to copy API key"));
      return;
    }
    setRevealedKey(copiedKey.value);
    setIsTemporarilyRevealed(!isRevealed());
    setCopied(true);
    if (copyTimeout) clearTimeout(copyTimeout);
    copyTimeout = setTimeout(() => {
      setCopied(false);
      setIsTemporarilyRevealed(false);
      if (!isRevealed()) setRevealedKey(null);
      copyTimeout = null;
    }, 2000);
  }

  async function deleteKey() {
    if (props.readonly) return;
    setIsDeleting(true);
    setErrorMessage("");
    const deleted = await settle(() => api.apiKeys.delete({ id: props.apiKey.id }));
    setIsDeleting(false);
    if (!deleted.ok) {
      setErrorMessage(errorText(deleted.error, "Failed to delete API key"));
      return;
    }
    if (!deleted.value.success) {
      setErrorMessage(deleted.value.error);
      return;
    }
    setDeleteDialogOpen(false);
    props.onDeleted(props.apiKey.id);
  }

  onCleanup(() => {
    if (copyTimeout) clearTimeout(copyTimeout);
  });

  return (
    <div>
      <div class="flex flex-col gap-2.5">
        <Show when={errorMessage()}>
          <p class="text-xs text-destructive">{errorMessage()}</p>
        </Show>
        <UiTooltip text={isKeyVisible() ? "Hide" : "Reveal"} disabled={props.readonly}>
          <button
            type="button"
            disabled={isLoading() || props.readonly}
            class={cn(
              "flex w-full cursor-pointer items-center gap-2 rounded-sm border border-border/60 bg-transparent px-2 py-2 text-left font-mono text-xs text-white outline-none transition-colors hover:bg-muted/30 disabled:cursor-default disabled:pointer-events-none disabled:opacity-50",
              isKeyVisible() ? "min-h-9" : "h-9"
            )}
            onClick={() => void revealKey()}
          >
            <span class={`min-w-0 flex-1 pr-2 ${isKeyVisible() ? "break-all whitespace-normal" : "truncate whitespace-nowrap"}`}>
              {displayKey()}
            </span>
            <UiIcon
              name={isKeyVisible() ? "i-lucide-eye-off" : "i-lucide-eye"}
              class="size-4 shrink-0 text-muted-foreground"
            />
          </button>
        </UiTooltip>

        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <UiTooltip text="Delete" disabled={props.readonly}>
              <UiButton
                variant="outline"
                size="icon-sm"
                class="h-8 w-8"
                disabled={props.readonly}
                onClick={() => setDeleteDialogOpen(true)}
              >
                <UiIcon name="i-lucide-trash-2" class="size-4 text-destructive" />
              </UiButton>
            </UiTooltip>
            <EditableApiKeyName
              id={props.apiKey.id}
              name={props.apiKey.name}
              keyPreview={props.apiKey.keyPreview}
              showTitle={false}
              readonly={props.readonly}
              pointsBalance={props.pointsBalance}
              onUpdated={props.onRenamed}
              onRefreshMe={props.onRefreshMe}
            />
          </div>
          <UiButton
            variant="outline"
            size="sm"
            class="h-8"
            disabled={isLoading() || props.readonly}
            onClick={() => void copyKey()}
          >
            <UiIcon name={copied() ? "i-lucide-check" : "i-lucide-copy"} class="size-4" />
            {copied() ? "Copied" : "Copy"}
          </UiButton>
        </div>
      </div>

      <UiDialog
        open={deleteDialogOpen()}
        onOpenChange={setDeleteDialogOpen}
        ui={{ content: "sm:max-w-[400px]" }}
        content={
          <>
            <div class="space-y-1.5 pr-6">
              <h2 class="text-lg font-semibold leading-none tracking-tight">Delete API Key</h2>
              <p class="text-sm text-muted-foreground">
                Delete <strong class="font-semibold text-foreground">{props.apiKey.name ?? ""}</strong> — this cannot be undone.
              </p>
            </div>
            <Show when={errorMessage()}>
              <p class="text-sm text-destructive">{errorMessage()}</p>
            </Show>
            <div class="flex justify-end gap-2">
              <UiButton variant="outline" size="sm" onClick={() => setDeleteDialogOpen(false)}>
                Cancel
              </UiButton>
              <UiButton variant="destructive" size="sm" disabled={isDeleting()} onClick={() => void deleteKey()}>
                {isDeleting() ? "Deleting..." : "Delete"}
              </UiButton>
            </div>
          </>
        }
      />
    </div>
  );
}
