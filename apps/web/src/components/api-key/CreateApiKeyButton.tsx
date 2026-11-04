import { Show, createMemo, createSignal, onCleanup, type JSX } from "solid-js";
import { api } from "~/api";
import { errorText, settle } from "~/lib/settle";
import { cn } from "~/lib/utils";
import { UiButton } from "~/components/ui/UiButton";
import { UiDialog } from "~/components/ui/UiDialog";
import { UiIcon } from "~/components/ui/UiIcon";

export interface CreateApiKeyButtonProps {
  triggerClass?: string;
  readonly?: boolean;
  onCreated: () => void;
}

export function CreateApiKeyButton(props: CreateApiKeyButtonProps): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [name, setName] = createSignal("");
  const [isCreating, setIsCreating] = createSignal(false);
  const [createdKey, setCreatedKey] = createSignal<string | null>(null);
  const [hasCreatedKey, setHasCreatedKey] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal("");
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  const createButtonLabel = createMemo(() => (name().trim() ? "Create" : "Skip"));

  function reset() {
    setName("");
    setCreatedKey(null);
    setHasCreatedKey(false);
    setCopied(false);
    setErrorMessage("");
  }

  function handleOpenChange(value: boolean) {
    if (!value) {
      if (hasCreatedKey()) props.onCreated();
      reset();
    }
    setOpen(value);
  }

  async function createKey() {
    if (props.readonly) return;
    setIsCreating(true);
    setErrorMessage("");
    const created = await settle(() => api.apiKeys.create({ name: name().trim() || undefined }));
    setIsCreating(false);
    if (!created.ok) {
      setErrorMessage(errorText(created.error, "Failed to create API key"));
      return;
    }
    if (!created.value.success) {
      setErrorMessage(created.value.error);
      return;
    }
    setCreatedKey(created.value.data.key);
    setHasCreatedKey(true);
  }

  async function copyKey() {
    const key = createdKey();
    if (!key) return;
    await navigator.clipboard.writeText(key);
    setCopied(true);
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      setCopied(false);
      setOpen(false);
      copyTimer = null;
    }, 2000);
  }

  onCleanup(() => {
    if (copyTimer) clearTimeout(copyTimer);
  });

  return (
    <>
      <UiButton
        variant="outline"
        class={cn("gap-2", props.triggerClass)}
        disabled={props.readonly}
        onClick={() => setOpen(true)}
      >
        <UiIcon name="i-lucide-plus" class="size-4" />
        Create API Key
      </UiButton>

      <UiDialog
        open={open()}
        onOpenChange={handleOpenChange}
        preventOutsideClose={isCreating()}
        preventEscapeClose={isCreating()}
        ui={{ content: "max-h-[calc(100dvh-1rem)] p-4 sm:max-w-md sm:p-6" }}
        content={
          <Show
            when={createdKey()}
            fallback={
              <>
                <div class="space-y-1.5 pr-6">
                  <h2 class="text-lg font-semibold leading-none tracking-tight">Create API Key</h2>
                  <p class="sr-only">Create a new API key for accessing Opendum.</p>
                </div>

                <form
                  class="space-y-4 py-1"
                  autocomplete="off"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void createKey();
                  }}
                >
                  <Show when={errorMessage()}>
                    <div class="relative w-full rounded-lg border border-destructive/50 px-4 py-3 text-sm text-destructive">
                      <UiIcon name="i-lucide-alert-circle" class="absolute left-4 top-4 size-4" />
                      <div class="pl-7 text-xs">{errorMessage()}</div>
                    </div>
                  </Show>

                  <div class="space-y-2">
                    <label for="api-key-name" class="text-sm font-medium">
                      Name
                    </label>
                    <input
                      id="api-key-name"
                      value={name()}
                      type="text"
                      disabled={isCreating()}
                      class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
                      placeholder="My API Key"
                      onInput={(event) => setName(event.currentTarget.value)}
                    />
                  </div>

                  <div class="flex justify-end gap-2">
                    <UiButton type="button" variant="outline" size="sm" disabled={isCreating()} onClick={() => setOpen(false)}>
                      Cancel
                    </UiButton>
                    <UiButton type="submit" size="sm" disabled={isCreating()}>
                      <Show when={isCreating()}>
                        <UiIcon name="i-lucide-loader-2" class="size-3.5 animate-spin" />
                      </Show>
                      {isCreating() ? "Creating..." : createButtonLabel()}
                    </UiButton>
                  </div>
                </form>
              </>
            }
          >
            <div class="space-y-1.5 pr-6">
              <h2 class="text-lg font-semibold leading-none tracking-tight">API Key Created</h2>
              <p class="sr-only">Your new API key is ready to use.</p>
            </div>
            <div class="space-y-4 py-1">
              <div class="rounded-md border border-border bg-muted/30 p-3">
                <p class="text-xs text-muted-foreground">Your API Key</p>
                <div class="mt-2 flex items-center gap-2">
                  <code class="flex-1 break-all rounded bg-background px-2 py-1 font-mono text-xs font-medium">
                    {createdKey()}
                  </code>
                  <UiButton type="button" variant="outline" size="sm" class="h-8 shrink-0 px-2" onClick={() => void copyKey()}>
                    <UiIcon name={copied() ? "i-lucide-check" : "i-lucide-copy"} class="size-3.5" />
                    {copied() ? "Copied" : "Copy"}
                  </UiButton>
                </div>
              </div>
            </div>
          </Show>
        }
      />
    </>
  );
}
