import { For, Show, createMemo, type JSX } from "solid-js";
import type { Provider } from "@opendum/providers/auth/config";
import { createAccountConnect } from "~/lib/account-connect";
import { cn } from "~/lib/utils";
import { CustomProviderSetup } from "~/components/account/CustomProviderSetup";
import { UiButton } from "~/components/ui/UiButton";
import { UiDialog } from "~/components/ui/UiDialog";
import { UiIcon } from "~/components/ui/UiIcon";
import { UiTooltip } from "~/components/ui/UiTooltip";

export interface AddAccountDialogProps {
  initialProvider?: Provider | null;
  triggerClass?: string;
  readonly?: boolean;
  onConnected: (result: { provider: Provider; email: string; isUpdate: boolean }) => void;
  onCustomCreated: (slug: string) => void;
}

const INPUT_CLASS =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50";

export function AddAccountDialog(props: AddAccountDialogProps): JSX.Element {
  const connect = createAccountConnect(
    () => props.initialProvider ?? null,
    () => props.readonly ?? false,
    {
      onConnected: (result) => props.onConnected(result),
      customCreated: (slug) => props.onCustomCreated(slug),
    }
  );

  const title = createMemo(() => {
    if (connect.customMode()) return "Add Custom Provider";
    const config = connect.selectedConfig();
    return config ? `Add ${config.name} Account` : "Add Provider Account";
  });

  const subtitle = createMemo(() => {
    const config = connect.selectedConfig();
    return config
      ? `Connect a new ${config.name} account for load balancing`
      : "Connect a new AI provider account for load balancing";
  });

  return (
    <>
      <UiButton variant="outline" class={cn("gap-2", props.triggerClass)} disabled={props.readonly} onClick={() => connect.setOpen(true)}>
        <UiIcon name="i-lucide-plus" class="size-4" />
        Add Account
      </UiButton>

      <UiDialog
        open={connect.open()}
        onOpenChange={connect.setDialogOpen}
        preventOutsideClose={connect.preventOutsideClose()}
        preventEscapeClose={connect.isPolling()}
        ui={{ content: "max-h-[calc(100dvh-1rem)] p-4 sm:max-w-lg sm:p-6" }}
        content={
          <Show
            when={!connect.customMode()}
            fallback={
              <CustomProviderSetup
                onCreated={(slug) => connect.customCreated(slug)}
                onCancel={() => connect.setOpen(false)}
              />
            }
          >
            <div class="space-y-1.5 pr-6">
              <h2 class="text-lg font-semibold leading-none tracking-tight">{title()}</h2>
              <p class="sr-only">{subtitle()}</p>
            </div>

            <div class="flex items-center justify-center py-2">
              <For each={connect.displayedSteps()}>
                {(stepNumber, index) => (
                  <div class="flex items-center">
                    <div
                      class={cn(
                        "flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium transition-colors",
                        connect.step() >= stepNumber ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                      )}
                    >
                      <Show when={connect.step() > stepNumber} fallback={index() + 1}>
                        <UiIcon name="i-lucide-check" class="size-4" />
                      </Show>
                    </div>
                    <Show when={index() < connect.displayedSteps().length - 1}>
                      <div class={cn("h-px w-10 transition-colors", connect.step() > stepNumber ? "bg-primary" : "bg-border")} />
                    </Show>
                  </div>
                )}
              </For>
            </div>

            <div class="min-h-0 flex-1 space-y-4 overflow-y-auto">
              <Show when={connect.step() === 1}>
                <div class="space-y-4">
                  <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <For each={connect.providerOptions}>
                      {(providerKey) => (
                        <button
                          type="button"
                          class={cn(
                            "flex cursor-pointer flex-col items-center gap-2 rounded-lg border p-3 text-center transition-colors hover:bg-muted/40",
                            connect.provider() === providerKey ? "border-foreground/30 bg-muted/30" : "border-border"
                          )}
                          onClick={() => connect.selectProvider(providerKey)}
                        >
                          <span class="text-sm font-medium">{connect.providerConfigs[providerKey]?.name}</span>
                        </button>
                      )}
                    </For>
                    <For each={connect.customList()}>
                      {(row) => (
                        <button
                          type="button"
                          class={cn(
                            "flex cursor-pointer flex-col items-center gap-2 rounded-lg border p-3 text-center transition-colors hover:bg-muted/40",
                            connect.provider() === row.slug ? "border-foreground/30 bg-muted/30" : "border-border"
                          )}
                          onClick={() => connect.selectProvider(row.slug)}
                        >
                          <span class="text-sm font-medium">{row.name}</span>
                        </button>
                      )}
                    </For>
                    <Show when={!props.readonly}>
                      <button
                        type="button"
                        class={cn(
                          "flex cursor-pointer flex-col items-center gap-2 rounded-lg border p-3 text-center transition-colors hover:bg-muted/40",
                          connect.customMode() ? "border-foreground/30 bg-muted/30" : "border-border"
                        )}
                        onClick={connect.selectCustom}
                      >
                        <span class="flex items-center gap-2 text-sm font-medium">
                          <UiIcon name="i-lucide-plus" class="size-4" />
                          Custom
                        </span>
                      </button>
                    </Show>
                  </div>
                </div>
              </Show>

              <Show when={connect.step() === 2 && connect.selectedConfig()}>
                <div class="space-y-4">
                  <div class="space-y-2">
                    <p class="text-sm font-medium">Choose {connect.selectedConfig()?.name} method</p>
                  </div>
                  <div class="grid gap-3">
                    <For each={connect.selectedConfig()?.methods ?? []}>
                      {(method) => (
                        <button
                          type="button"
                          disabled={method.disabled}
                          class={cn(
                            "flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
                            connect.selectedMethod() === method.key ? "border-foreground/30 bg-muted/30" : "border-border"
                          )}
                          onClick={() => connect.selectLogin(method.key)}
                        >
                          <span class="flex items-center gap-2 text-sm font-medium">
                            {method.name}
                            <Show when={method.tag}>
                              <span class="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                                {method.tag}
                              </span>
                            </Show>
                            <Show when={method.disabled}>
                              <span class="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                                Unavailable
                              </span>
                            </Show>
                          </span>
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              </Show>

              <Show
                when={
                  (connect.step() === connect.authStep() ||
                    (connect.step() === connect.finishStep() && connect.activeFlowType() === "device_code" && connect.isPolling())) &&
                  connect.selectedConfig() &&
                  connect.activeFlowType()
                }
              >
                <div class="space-y-4">
                  <Show when={connect.activeFlowType() === "oauth_redirect"}>
                    <div class="space-y-2">
                      <p class="text-sm font-medium">Login to {connect.selectedConfig()?.name}</p>
                      <p class="text-sm text-muted-foreground">
                        Click the button below to open the login page in a new window. After logging in, you'll be redirected
                        to a page that shows an error - this is expected.
                      </p>
                    </div>
                    <div class="flex gap-2">
                      <UiButton variant="outline" class="flex-1" disabled={connect.isFetchingUrl() || !connect.authUrl()} onClick={connect.oauthUrl}>
                        <UiIcon
                          name={connect.isFetchingUrl() ? "i-lucide-loader-2" : "i-lucide-external-link"}
                          class={cn("size-4", connect.isFetchingUrl() && "animate-spin")}
                        />
                        Open {connect.selectedConfig()?.name} Login
                      </UiButton>
                      <UiTooltip text={connect.copiedLink() ? "Copied" : "Copy link"}>
                        <UiButton
                          variant="outline"
                          disabled={connect.isFetchingUrl() || !connect.authUrl()}
                          onClick={() => void connect.copyText(connect.authUrl(), "link")}
                        >
                          <UiIcon name={connect.copiedLink() ? "i-lucide-check" : "i-lucide-copy"} class="size-4" />
                        </UiButton>
                      </UiTooltip>
                    </div>
                    <div class="relative w-full rounded-lg border px-4 py-3 text-sm">
                      <UiIcon name="i-lucide-alert-circle" class="absolute left-4 top-4 size-4" />
                      <div class="pl-7 text-xs">
                        After login, copy the URL from address bar:
                        <code class="rounded bg-muted px-1">{connect.callbackPlaceholder(connect.provider())}</code>
                      </div>
                    </div>
                  </Show>

                  <Show when={connect.activeFlowType() === "device_code"}>
                    <div class="space-y-2">
                      <p class="text-sm font-medium">Login to {connect.selectedConfig()?.name}</p>
                      <p class="text-sm text-muted-foreground">
                        Click the button below to open the provider login page. Enter the code shown below on the provider
                        login page. After you complete the login, authorization will be detected automatically.
                      </p>
                    </div>
                    <Show when={connect.deviceCodeInfo()?.userCode}>
                      <div class="rounded-md border border-border bg-muted/30 p-3">
                        <p class="text-xs text-muted-foreground">Enter this code on the provider page:</p>
                        <div class="mt-2 flex flex-wrap items-center gap-2">
                          <code class="rounded bg-background px-2 py-1 font-mono text-sm font-semibold tracking-[0.15em]">
                            {connect.deviceCodeInfo()?.userCode}
                          </code>
                          <UiButton
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => void connect.copyText(connect.deviceCodeInfo()?.userCode ?? "", "code")}
                          >
                            <UiIcon name={connect.copiedDeviceCode() ? "i-lucide-check" : "i-lucide-copy"} class="size-3.5" />
                            {connect.copiedDeviceCode() ? "Copied" : "Copy code"}
                          </UiButton>
                        </div>
                      </div>
                    </Show>
                    <div class="flex gap-2">
                      <UiButton
                        variant="outline"
                        class="flex-1"
                        disabled={connect.isFetchingUrl() || !connect.deviceCodeInfo()}
                        onClick={connect.deviceUrl}
                      >
                        <UiIcon
                          name={connect.isFetchingUrl() ? "i-lucide-loader-2" : "i-lucide-external-link"}
                          class={cn("size-4", connect.isFetchingUrl() && "animate-spin")}
                        />
                        Open {connect.selectedConfig()?.name} Login
                      </UiButton>
                      <UiTooltip text={connect.copiedLink() ? "Copied" : "Copy link"}>
                        <UiButton
                          variant="outline"
                          disabled={connect.isFetchingUrl() || !connect.deviceCodeInfo()}
                          onClick={() => {
                            const info = connect.deviceCodeInfo();
                            if (info) void connect.copyText(info.verificationUrl, "link");
                          }}
                        >
                          <UiIcon name={connect.copiedLink() ? "i-lucide-check" : "i-lucide-copy"} class="size-4" />
                        </UiButton>
                      </UiTooltip>
                    </div>
                    <Show when={connect.isPolling()}>
                      <div class="relative w-full rounded-lg border px-4 py-3 text-sm">
                        <UiIcon name="i-lucide-loader-2" class="absolute left-4 top-4 size-4 animate-spin" />
                        <div class="pl-7 text-xs">
                          Complete the login in your browser. This dialog will close automatically when authorization is
                          complete.
                        </div>
                      </div>
                    </Show>
                  </Show>

                  <Show when={connect.activeFlowType() === "chatgpt_session"}>
                    <div class="space-y-2">
                      <p class="text-sm font-medium">Copy ChatGPT session</p>
                      <p class="text-sm text-muted-foreground">
                        Open the session page while logged in to ChatGPT, copy the full response, then paste it here. This
                        method has no refresh token, so reconnect when the access token expires.
                      </p>
                    </div>
                    <div class="rounded-md border border-border bg-muted/30 p-3">
                      <p class="break-all text-xs text-muted-foreground">https://chatgpt.com/api/auth/session</p>
                    </div>
                    <div class="flex gap-2">
                      <UiButton
                        type="button"
                        variant="outline"
                        class="flex-1"
                        onClick={() => connect.openPopup("https://chatgpt.com/api/auth/session", "chatgpt_session", 1100, 760)}
                      >
                        <UiIcon name="i-lucide-external-link" class="size-4" />
                        Open Session Page
                      </UiButton>
                      <UiTooltip text={connect.copiedLink() ? "Copied" : "Copy link"}>
                        <UiButton
                          type="button"
                          variant="outline"
                          onClick={() => void connect.copyText("https://chatgpt.com/api/auth/session", "link")}
                        >
                          <UiIcon name={connect.copiedLink() ? "i-lucide-check" : "i-lucide-copy"} class="size-4" />
                        </UiButton>
                      </UiTooltip>
                    </div>
                  </Show>

                  <Show
                    when={
                      connect.activeFlowType() !== "oauth_redirect" &&
                      connect.activeFlowType() !== "device_code" &&
                      connect.activeFlowType() !== "chatgpt_session"
                    }
                  >
                    <div class="space-y-2">
                      <p class="text-sm font-medium">Get {connect.selectedConfig()?.name} API Key</p>
                      <p class="text-sm text-muted-foreground">
                        Open the provider page below and create or copy your API key. You will continue to the next step
                        automatically.
                      </p>
                    </div>
                    <div class="rounded-md border border-border bg-muted/30 p-3">
                      <p class="break-all text-xs text-muted-foreground">{connect.selectedConfig()?.apiKeyPortalUrl}</p>
                    </div>
                    <div class="flex gap-2">
                      <UiButton type="button" variant="outline" class="flex-1" onClick={connect.keyPortal}>
                        <UiIcon name="i-lucide-external-link" class="size-4" />
                        Open {connect.selectedConfig()?.name} Portal
                      </UiButton>
                      <UiTooltip text={connect.copiedLink() ? "Copied" : "Copy link"}>
                        <UiButton
                          type="button"
                          variant="outline"
                          onClick={() => {
                            if (connect.authUrl()) void connect.copyText(connect.authUrl(), "link");
                          }}
                        >
                          <UiIcon name={connect.copiedLink() ? "i-lucide-check" : "i-lucide-copy"} class="size-4" />
                        </UiButton>
                      </UiTooltip>
                    </div>
                  </Show>

                  <Show when={connect.errorMessage()}>
                    <div class="relative w-full rounded-lg border border-destructive/50 px-4 py-3 text-sm text-destructive">
                      <UiIcon name="i-lucide-alert-circle" class="absolute left-4 top-4 size-4" />
                      <div class="pl-7 text-xs">{connect.errorMessage()}</div>
                    </div>
                  </Show>
                </div>
              </Show>

              <Show
                when={
                  connect.step() === connect.finishStep() &&
                  connect.selectedConfig() &&
                  connect.activeFlowType() === "oauth_redirect"
                }
              >
                <form class="space-y-4" onSubmit={(event) => event.preventDefault()}>
                  <div class="space-y-2">
                    <label for="callback-url" class="text-sm font-medium">
                      Paste Callback URL <span aria-hidden="true" class="text-destructive">*</span>
                    </label>
                    <p class="text-sm text-muted-foreground">Paste the URL from your browser after the OAuth redirect.</p>
                    <div class="relative">
                      <input
                        id="callback-url"
                        value={connect.callbackUrl()}
                        type="text"
                        placeholder={connect.callbackPlaceholder(connect.provider())}
                        disabled={connect.isLoading()}
                        class={cn(INPUT_CLASS, "pr-9")}
                        onInput={connect.callbackInput}
                        onPaste={connect.callbackPaste}
                      />
                      <UiTooltip text={connect.copiedCallbackUrl() ? "Pasted" : "Paste"}>
                        <button
                          type="button"
                          disabled={connect.isLoading()}
                          class="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                          aria-label="Paste callback URL"
                          onClick={() => void connect.pasteCallback()}
                        >
                          <UiIcon
                            name={
                              connect.isLoading()
                                ? "i-lucide-loader-2"
                                : connect.copiedCallbackUrl()
                                  ? "i-lucide-check"
                                  : "i-lucide-clipboard-paste"
                            }
                            class={cn("size-4", connect.isLoading() && "animate-spin")}
                          />
                        </button>
                      </UiTooltip>
                    </div>
                    <Show when={connect.errorMessage()}>
                      <p class="text-sm text-destructive">{connect.errorMessage()}</p>
                    </Show>
                  </div>
                </form>
              </Show>

              <Show
                when={
                  connect.step() === connect.finishStep() &&
                  connect.selectedConfig() &&
                  connect.activeFlowType() === "chatgpt_session"
                }
              >
                <form
                  class="space-y-4"
                  autocomplete="off"
                  data-lpignore="true"
                  data-1p-ignore="true"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void connect.connectCodex();
                  }}
                >
                  <div class="space-y-2">
                    <label for="chatgpt-session-json" class="text-sm font-medium">
                      Paste Session <span aria-hidden="true" class="text-destructive">*</span>
                    </label>
                    <p class="text-sm text-muted-foreground">
                      Paste the full response from <code class="rounded bg-muted px-1">chatgpt.com/api/auth/session</code>.
                    </p>
                    <textarea
                      id="chatgpt-session-json"
                      value={connect.chatgptSessionJson()}
                      name="chatgpt-session-json"
                      autocomplete="off"
                      autocorrect="off"
                      autocapitalize="none"
                      spellcheck={false}
                      data-lpignore="true"
                      data-1p-ignore="true"
                      disabled={connect.isLoading()}
                      placeholder={connect.chatgptSessionPlaceholder}
                      class="min-h-36 w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
                      onInput={(event) => connect.setChatgptSessionJson(event.currentTarget.value)}
                    />
                  </div>

                  <Show when={connect.errorMessage()}>
                    <p class="text-sm text-destructive">{connect.errorMessage()}</p>
                  </Show>

                  <UiButton type="submit" class="w-full" disabled={connect.isLoading()}>
                    <Show when={connect.isLoading()}>
                      <UiIcon name="i-lucide-loader-2" class="size-4 animate-spin" />
                    </Show>
                    {connect.isLoading() ? "Connecting..." : "Connect Codex Account"}
                  </UiButton>
                </form>
              </Show>

              <Show
                when={
                  connect.step() === connect.finishStep() &&
                  connect.selectedConfig() &&
                  (connect.activeFlowType() === "api_key" || connect.activeFlowType() === "api_key_with_account_id")
                }
              >
                <form
                  class="space-y-4"
                  autocomplete="off"
                  data-lpignore="true"
                  data-1p-ignore="true"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void connect.connectKey();
                  }}
                >
                  <div class="space-y-2">
                    <p class="text-sm font-medium">Connect {connect.selectedConfig()?.name}</p>
                    <p class="text-sm text-muted-foreground">
                      {connect.activeFlowType() === "api_key_with_account_id"
                        ? "Paste your API token and Account ID. Credentials will be stored encrypted."
                        : "Paste your provider API key directly. The key will be stored encrypted."}
                    </p>
                  </div>

                  <div class="space-y-2">
                    <label for="provider-api-key" class="text-sm font-medium">
                      {connect.activeFlowType() === "api_key_with_account_id" ? "API Token" : "API Key"}{" "}
                      <span aria-hidden="true" class="text-destructive">*</span>
                    </label>
                    <div class="relative">
                      <input
                        id="provider-api-key"
                        value={connect.apiKey()}
                        type="text"
                        name="provider-token"
                        autocomplete="off"
                        autocorrect="off"
                        autocapitalize="none"
                        spellcheck={false}
                        data-lpignore="true"
                        data-1p-ignore="true"
                        placeholder={connect.selectedConfig()?.apiKeyPlaceholder}
                        disabled={connect.isLoading()}
                        class={cn(INPUT_CLASS, "pr-9", !connect.apiKeyVisible() && "[text-security:disc] [-webkit-text-security:disc]")}
                        onInput={(event) => connect.setApiKey(event.currentTarget.value)}
                      />
                      <UiTooltip text={connect.apiKeyVisible() ? "Hide" : "Show"}>
                        <button
                          type="button"
                          disabled={connect.isLoading()}
                          class="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                          aria-label={connect.apiKeyVisible() ? "Hide API key" : "Show API key"}
                          onClick={() => connect.setApiKeyVisible(!connect.apiKeyVisible())}
                        >
                          <UiIcon name={connect.apiKeyVisible() ? "i-lucide-eye-off" : "i-lucide-eye"} class="size-4" />
                        </button>
                      </UiTooltip>
                    </div>
                  </div>

                  <Show when={connect.provider() === "zenmux"}>
                    <div class="space-y-2">
                      <label for="provider-platform-key" class="text-sm font-medium">
                        Platform Key <span aria-hidden="true" class="text-destructive">*</span>
                      </label>
                      <input
                        id="provider-platform-key"
                        value={connect.platformKey()}
                        type="text"
                        class={cn(INPUT_CLASS, "font-mono")}
                        placeholder="Platform Key"
                        disabled={connect.isLoading()}
                        onInput={(event) => connect.setPlatformKey(event.currentTarget.value)}
                      />
                    </div>
                  </Show>

                  <Show when={connect.activeFlowType() === "api_key_with_account_id"}>
                    <div class="space-y-2">
                      <label for="provider-account-id" class="text-sm font-medium">
                        {connect.selectedConfig()?.accountIdLabel} <span aria-hidden="true" class="text-destructive">*</span>
                      </label>
                      <input
                        id="provider-account-id"
                        value={connect.cfAccountId()}
                        type="text"
                        class={cn(INPUT_CLASS, "font-mono")}
                        placeholder={connect.selectedConfig()?.accountIdPlaceholder}
                        disabled={connect.isLoading()}
                        onInput={(event) => connect.setCfAccountId(event.currentTarget.value)}
                      />
                    </div>
                  </Show>

                  <Show when={connect.errorMessage()}>
                    <p class="text-sm text-destructive">{connect.errorMessage()}</p>
                  </Show>

                  <UiButton type="submit" class="w-full" disabled={connect.isLoading()}>
                    <Show when={connect.isLoading()}>
                      <UiIcon name="i-lucide-loader-2" class="size-4 animate-spin" />
                    </Show>
                    {connect.isLoading() ? "Connecting..." : `Connect ${connect.selectedConfig()?.name}`}
                  </UiButton>
                </form>
              </Show>
            </div>

            <div class="flex items-center justify-between gap-2">
              <UiButton variant="ghost" disabled={connect.isLoading() || connect.isPolling()} onClick={connect.goBack}>
                <UiIcon name="i-lucide-arrow-left" class="size-4" />
                Back
              </UiButton>
              <Show when={connect.isPolling()}>
                <UiButton variant="ghost" onClick={connect.backPolling}>
                  Cancel
                </UiButton>
              </Show>
            </div>
          </Show>
        }
      />
    </>
  );
}
