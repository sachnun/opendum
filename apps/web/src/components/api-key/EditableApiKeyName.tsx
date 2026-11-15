import { Show, createSignal, type JSX } from "solid-js";
import { api } from "~/api";
import { errorText, settle } from "~/lib/settle";
import { cn } from "~/lib/utils";
import { PointCoinIcon } from "~/components/common/PointCoinIcon";
import { UiButton } from "~/components/ui/UiButton";
import { UiDialog } from "~/components/ui/UiDialog";
import { UiIcon } from "~/components/ui/UiIcon";
import { UiTooltip } from "~/components/ui/UiTooltip";

const MIN_LENGTH = 3;
const MAX_LENGTH = 100;
const UPDATE_COST = 20;
const ALLOWED_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface EditableApiKeyNameProps {
  id: string;
  name: string | null;
  keyPreview?: string;
  showTitle?: boolean;
  showEditButton?: boolean;
  readonly?: boolean;
  pointsBalance?: number;
  onUpdated: (value: { name: string | null; keyPreview?: string }) => void;
  onRefreshMe?: () => void;
}

export function EditableApiKeyName(props: EditableApiKeyNameProps): JSX.Element {
  const [editDialogOpen, setEditDialogOpen] = createSignal(false);
  const [newName, setNewName] = createSignal(props.name ?? "");
  const [apiKeyValue, setApiKeyValue] = createSignal("");
  const [revealedApiKey, setRevealedApiKey] = createSignal<string | null>(null);
  const [isDirty, setIsDirty] = createSignal(false);
  const [isUpdating, setIsUpdating] = createSignal(false);
  const [isRevealing, setIsRevealing] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal("");

  const maskedApiKey = () => props.keyPreview || "********";
  const normalizedValue = () => apiKeyValue().trim();
  const saveCostsPoints = () => isDirty() && normalizedValue() !== revealedApiKey();
  const costLabel = () => UPDATE_COST.toLocaleString("en-US");
  const hasInsufficientPoints = () => saveCostsPoints() && (props.pointsBalance ?? 0) < UPDATE_COST;
  const validationError = () => {
    if (!saveCostsPoints()) return "";
    if (normalizedValue().length < MIN_LENGTH) return `API key must be at least ${MIN_LENGTH} characters`;
    if (normalizedValue().length > MAX_LENGTH) return `API key must be at most ${MAX_LENGTH} characters`;
    if (!ALLOWED_PATTERN.test(normalizedValue())) return "API key can only contain letters, numbers, hyphen, and underscore";
    return "";
  };

  function openDialog() {
    setNewName(props.name ?? "");
    setApiKeyValue(maskedApiKey());
    setRevealedApiKey(null);
    setIsDirty(false);
    setErrorMessage("");
    setEditDialogOpen(true);
  }

  async function reveal() {
    if (props.readonly || revealedApiKey() || isRevealing()) return;
    setIsRevealing(true);
    setErrorMessage("");
    const updated = await settle(() => api.apiKeys.reveal({ id: props.id }));
    setIsRevealing(false);
    if (!updated.ok) {
      setErrorMessage(errorText(updated.error, "Failed to reveal API key"));
      return;
    }
    if (!updated.value.success) {
      setErrorMessage(updated.value.error);
      return;
    }
    setRevealedApiKey(updated.value.data.key);
    setApiKeyValue(updated.value.data.key);
    setIsDirty(false);
  }

  function markDirty() {
    if (!revealedApiKey()) return;
    setIsDirty(true);
  }

  async function updateName() {
    if (props.readonly) return;
    if (validationError()) return;
    if (hasInsufficientPoints()) return;
    setIsUpdating(true);
    setErrorMessage("");
    const updated = await settle(() =>
      api.apiKeys.updateName({
        id: props.id,
        name: newName(),
        ...(saveCostsPoints() ? { key: normalizedValue() } : {}),
      })
    );
    setIsUpdating(false);
    if (!updated.ok) {
      setErrorMessage(errorText(updated.error, "Failed to update API key"));
      return;
    }
    if (!updated.value.success) {
      setErrorMessage(updated.value.error);
      return;
    }
    const result = updated.value;
    setEditDialogOpen(false);
    if (saveCostsPoints()) props.onRefreshMe?.();
    props.onUpdated({ name: result.data.name, keyPreview: result.data.keyPreview });
  }

  return (
    <div class="flex min-w-0 items-center gap-1.5">
      <Show when={props.showTitle ?? true}>
        <span class="min-w-0 truncate text-lg font-semibold">{props.name ?? ""}</span>
      </Show>
      <Show when={props.showEditButton ?? true}>
        <UiTooltip text="Edit" disabled={props.readonly}>
          <UiButton
            variant="outline"
            size="icon-sm"
            class="h-8 w-8"
            disabled={props.readonly}
            onClick={openDialog}
          >
            <UiIcon name="i-lucide-pencil" class="size-4" />
          </UiButton>
        </UiTooltip>
      </Show>

      <UiDialog
        open={editDialogOpen()}
        onOpenChange={setEditDialogOpen}
        ui={{ content: "sm:max-w-md" }}
        content={
          <>
            <Show when={errorMessage()}>
              <div class="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {errorMessage()}
              </div>
            </Show>
            <label class="grid gap-1 text-sm font-medium">
              <span>
                Name <span class="text-destructive">*</span>
              </span>
              <input
                value={newName()}
                onInput={(event) => setNewName(event.currentTarget.value)}
                class="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                placeholder="My API Key"
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void updateName();
                  }
                }}
              />
            </label>
            <label class="grid gap-1 text-sm font-medium">
              <span>API Key</span>
              <div class="relative">
                <input
                  value={apiKeyValue()}
                  class={cn(
                    "h-9 w-full rounded-md border bg-background px-3 pr-9 font-mono text-sm outline-none focus-visible:ring-[3px]",
                    validationError()
                      ? "border-destructive focus-visible:border-destructive focus-visible:ring-destructive/20"
                      : "border-input focus-visible:border-ring focus-visible:ring-ring/50"
                  )}
                  readOnly={!revealedApiKey() || isRevealing()}
                  onFocus={() => void reveal()}
                  onClick={() => void reveal()}
                  onInput={(event) => {
                    setApiKeyValue(event.currentTarget.value);
                    markDirty();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void updateName();
                    }
                  }}
                />
                <Show when={isRevealing()}>
                  <UiIcon
                    name="i-lucide-loader-2"
                    class="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground"
                  />
                </Show>
              </div>
              <Show when={validationError()}>
                <span class="text-xs font-normal text-destructive">{validationError()}</span>
              </Show>
              <Show when={!validationError() && hasInsufficientPoints()}>
                <span class="text-xs font-normal text-destructive">Not enough points.</span>
              </Show>
            </label>
            <div class="flex justify-end gap-2">
              <UiButton variant="outline" onClick={() => setEditDialogOpen(false)}>
                Cancel
              </UiButton>
              <UiButton
                class="w-24 transition-colors"
                disabled={isUpdating() || isRevealing() || Boolean(validationError()) || hasInsufficientPoints()}
                onClick={() => void updateName()}
              >
                <Show when={!isUpdating() && saveCostsPoints()} fallback={isUpdating() ? "Saving..." : "Save"}>
                  <PointCoinIcon reverse class="size-5 shrink-0 text-foreground/85 drop-shadow-[0_0_0.35rem_rgba(255,255,255,0.18)]" />
                  {costLabel()}
                </Show>
              </UiButton>
            </div>
          </>
        }
      />
    </div>
  );
}
