<script setup lang="ts">
import { cn } from "~~/lib/utils";
import type { Provider } from "~~/lib/provider-auth-config";

const props = withDefaults(
  defineProps<{
    initialProvider?: Provider | null;
    triggerClass?: string;
    readonly?: boolean;
  }>(),
  {
    initialProvider: null,
    triggerClass: "",
    readonly: false,
  }
);

const emit = defineEmits<{
  connected: [result: { provider: Provider; email: string; isUpdate: boolean }];
  customCreated: [slug: string];
}>();

const {
  customList,
  open,
  customMode,
  minimumStep,
  step,
  provider,
  callbackUrl,
  chatgptSessionJson,
  apiKey,
  platformKey,
  cfAccountId,
  authUrl,
  selectedMethod,
  deviceCodeInfo,
  copiedLink,
  copiedDeviceCode,
  copiedCallbackUrl,
  isApiKeyVisible,
  isLoading,
  isFetchingUrl,
  isPolling,
  errorMessage,
  selectedConfig,
  activeFlowType,
  authStep,
  finishStep,
  dialogOpen,
  displayedSteps,
  shouldPreventOutsideClose,
  handleCustomCreated,
  selectProvider,
  selectCustom,
  selectLoginMethod,
  copyText,
  openPopup,
  openOAuthUrl,
  openDeviceAuthUrl,
  openApiKeyPortal,
  handleConnectApiKey,
  handleConnectCodexSession,
  handleCallbackInput,
  pasteCallbackUrl,
  handleCallbackPaste,
  goBack,
  goBackFromDevicePolling,
  providerOptions,
  chatgptSessionPlaceholder,
  providerConfigs,
  callbackPlaceholder,
} = useAccountConnect(props, {
  onConnected: (result) => emit("connected", result),
  onCustomCreated: (slug) => emit("customCreated", slug),
});
</script>

<template>
  <UiButton variant="outline" :class="cn('gap-2', triggerClass)" :disabled="readonly" @click="open = true">
    <UiIcon name="i-lucide-plus" class="size-4" />
    Add Account
  </UiButton>

  <UiDialog
    v-model:open="dialogOpen"
    :prevent-outside-close="shouldPreventOutsideClose"
    :prevent-escape-close="isPolling"
    :ui="{ content: 'max-h-[calc(100dvh-1rem)] p-4 sm:max-w-lg sm:p-6' }"
  >
    <template #content>
      <div class="space-y-1.5 pr-6">
        <h2 class="text-lg font-semibold leading-none tracking-tight">
          {{ customMode ? 'Add Custom Provider' : selectedConfig ? `Add ${selectedConfig.name} Account` : 'Add Provider Account' }}
        </h2>
        <p class="sr-only">
          {{ selectedConfig ? `Connect a new ${selectedConfig.name} account for load balancing` : 'Connect a new AI provider account for load balancing' }}
        </p>
      </div>

      <template v-if="!customMode">
      <div class="flex items-center justify-center py-2">
        <template v-for="(stepNumber, index) in displayedSteps" :key="stepNumber">
          <div class="flex items-center">
            <div
              :class="cn(
                'flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium transition-colors',
                step >= stepNumber ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
              )"
            >
              <UiIcon v-if="step > stepNumber" name="i-lucide-check" class="size-4" />
              <span v-else>{{ index + 1 }}</span>
            </div>
            <div v-if="index < displayedSteps.length - 1" :class="cn('h-px w-10 transition-colors', step > stepNumber ? 'bg-primary' : 'bg-border')" />
          </div>
        </template>
      </div>

      <div class="min-h-0 flex-1 space-y-4 overflow-y-auto">
        <div v-if="step === 1" class="space-y-4">
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <button
              v-for="providerKey in providerOptions"
              :key="providerKey"
              type="button"
              :class="cn(
                'flex cursor-pointer flex-col items-center gap-2 rounded-lg border p-3 text-center transition-colors hover:bg-muted/40',
                provider === providerKey ? 'border-foreground/30 bg-muted/30' : 'border-border',
              )"
              @click="selectProvider(providerKey)"
            >
              <span class="text-sm font-medium">{{ providerConfigs[providerKey]?.name }}</span>
            </button>
            <button
              v-for="row in customList"
              :key="row.slug"
              type="button"
              :class="cn(
                'flex cursor-pointer flex-col items-center gap-2 rounded-lg border p-3 text-center transition-colors hover:bg-muted/40',
                provider === row.slug ? 'border-foreground/30 bg-muted/30' : 'border-border',
              )"
              @click="selectProvider(row.slug)"
            >
              <span class="text-sm font-medium">{{ row.name }}</span>
            </button>
            <button
              v-if="!readonly"
              type="button"
              :class="cn(
                'flex cursor-pointer flex-col items-center gap-2 rounded-lg border p-3 text-center transition-colors hover:bg-muted/40',
                customMode ? 'border-foreground/30 bg-muted/30' : 'border-border',
              )"
              @click="selectCustom"
            >
              <span class="flex items-center gap-2 text-sm font-medium">
                <UiIcon name="i-lucide-plus" class="size-4" />
                Custom
              </span>
            </button>
          </div>
        </div>

        <div v-if="step === 2 && selectedConfig" class="space-y-4">
          <div class="space-y-2">
            <p class="text-sm font-medium">Choose {{ selectedConfig.name }} method</p>
          </div>
          <div class="grid gap-3">
            <button
              v-for="method in selectedConfig.methods"
              :key="method.key"
              type="button"
              :disabled="method.disabled"
              :class="cn(
                'flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
                selectedMethod === method.key ? 'border-foreground/30 bg-muted/30' : 'border-border',
              )"
              @click="selectLoginMethod(method.key)"
            >
              <span class="flex items-center gap-2 text-sm font-medium">
                {{ method.name }}
                <span v-if="method.tag" class="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{{ method.tag }}</span>
                <span v-if="method.disabled" class="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">Unavailable</span>
              </span>
            </button>
          </div>
        </div>

        <div v-if="(step === authStep || (step === finishStep && activeFlowType === 'device_code' && isPolling)) && selectedConfig && activeFlowType" class="space-y-4">
          <template v-if="activeFlowType === 'oauth_redirect'">
            <div class="space-y-2">
              <p class="text-sm font-medium">Login to {{ selectedConfig.name }}</p>
              <p class="text-sm text-muted-foreground">
                Click the button below to open the login page in a new window. After logging in, you'll be redirected to a page that shows an error - this is expected.
              </p>
            </div>
            <div class="flex gap-2">
              <UiButton variant="outline" class="flex-1" :disabled="isFetchingUrl || !authUrl" @click="openOAuthUrl">
                <UiIcon :name="isFetchingUrl ? 'i-lucide-loader-2' : 'i-lucide-external-link'" :class="['size-4', isFetchingUrl ? 'animate-spin' : '']" />
                Open {{ selectedConfig.name }} Login
              </UiButton>
              <UiTooltip :text="copiedLink ? 'Copied' : 'Copy link'">
                <UiButton variant="outline" :disabled="isFetchingUrl || !authUrl" @click="copyText(authUrl, 'link')">
                  <UiIcon :name="copiedLink ? 'i-lucide-check' : 'i-lucide-copy'" class="size-4" />
                </UiButton>
              </UiTooltip>
            </div>
            <div class="relative w-full rounded-lg border px-4 py-3 text-sm">
              <UiIcon name="i-lucide-alert-circle" class="absolute left-4 top-4 size-4" />
              <div class="pl-7 text-xs">
                After login, copy the URL from address bar:
                <code class="rounded bg-muted px-1">{{ callbackPlaceholder(provider) }}</code>
              </div>
            </div>
          </template>

          <template v-else-if="activeFlowType === 'device_code'">
            <div class="space-y-2">
              <p class="text-sm font-medium">Login to {{ selectedConfig.name }}</p>
              <p class="text-sm text-muted-foreground">
                Click the button below to open the provider login page. Enter the code shown below on the provider login page. After you complete the login, authorization will be detected automatically.
              </p>
            </div>
            <div v-if="deviceCodeInfo?.userCode" class="rounded-md border border-border bg-muted/30 p-3">
              <p class="text-xs text-muted-foreground">Enter this code on the provider page:</p>
              <div class="mt-2 flex flex-wrap items-center gap-2">
                <code class="rounded bg-background px-2 py-1 font-mono text-sm font-semibold tracking-[0.15em]">{{ deviceCodeInfo.userCode }}</code>
                <UiButton type="button" size="sm" variant="outline" @click="copyText(deviceCodeInfo.userCode, 'code')">
                  <UiIcon :name="copiedDeviceCode ? 'i-lucide-check' : 'i-lucide-copy'" class="size-3.5" />
                  {{ copiedDeviceCode ? 'Copied' : 'Copy code' }}
                </UiButton>
              </div>
            </div>
            <div class="flex gap-2">
              <UiButton variant="outline" class="flex-1" :disabled="isFetchingUrl || !deviceCodeInfo" @click="openDeviceAuthUrl">
                <UiIcon :name="isFetchingUrl ? 'i-lucide-loader-2' : 'i-lucide-external-link'" :class="['size-4', isFetchingUrl ? 'animate-spin' : '']" />
                Open {{ selectedConfig.name }} Login
              </UiButton>
              <UiTooltip :text="copiedLink ? 'Copied' : 'Copy link'">
                <UiButton variant="outline" :disabled="isFetchingUrl || !deviceCodeInfo" @click="deviceCodeInfo && copyText(deviceCodeInfo.verificationUrl, 'link')">
                  <UiIcon :name="copiedLink ? 'i-lucide-check' : 'i-lucide-copy'" class="size-4" />
                </UiButton>
              </UiTooltip>
            </div>
            <div v-if="isPolling" class="relative w-full rounded-lg border px-4 py-3 text-sm">
              <UiIcon name="i-lucide-loader-2" class="absolute left-4 top-4 size-4 animate-spin" />
              <div class="pl-7 text-xs">
                Complete the login in your browser. This dialog will close automatically when authorization is complete.
              </div>
            </div>
          </template>

          <template v-else-if="activeFlowType === 'chatgpt_session'">
            <div class="space-y-2">
              <p class="text-sm font-medium">Copy ChatGPT session</p>
              <p class="text-sm text-muted-foreground">
                Open the session page while logged in to ChatGPT, copy the full response, then paste it here. This method has no refresh token, so reconnect when the access token expires.
              </p>
            </div>
            <div class="rounded-md border border-border bg-muted/30 p-3">
              <p class="break-all text-xs text-muted-foreground">https://chatgpt.com/api/auth/session</p>
            </div>
            <div class="flex gap-2">
              <UiButton type="button" variant="outline" class="flex-1" @click="openPopup('https://chatgpt.com/api/auth/session', 'chatgpt_session', 1100, 760)">
                <UiIcon name="i-lucide-external-link" class="size-4" />
                Open Session Page
              </UiButton>
              <UiTooltip :text="copiedLink ? 'Copied' : 'Copy link'">
                <UiButton type="button" variant="outline" @click="copyText('https://chatgpt.com/api/auth/session', 'link')">
                  <UiIcon :name="copiedLink ? 'i-lucide-check' : 'i-lucide-copy'" class="size-4" />
                </UiButton>
              </UiTooltip>
            </div>
          </template>

          <template v-else>
            <div class="space-y-2">
              <p class="text-sm font-medium">Get {{ selectedConfig.name }} API Key</p>
              <p class="text-sm text-muted-foreground">
                Open the provider page below and create or copy your API key. You will continue to the next step automatically.
              </p>
            </div>
            <div class="rounded-md border border-border bg-muted/30 p-3">
              <p class="break-all text-xs text-muted-foreground">{{ selectedConfig.apiKeyPortalUrl }}</p>
            </div>
            <div class="flex gap-2">
              <UiButton type="button" variant="outline" class="flex-1" @click="openApiKeyPortal">
                <UiIcon name="i-lucide-external-link" class="size-4" />
                Open {{ selectedConfig.name }} Portal
              </UiButton>
              <UiTooltip :text="copiedLink ? 'Copied' : 'Copy link'">
                <UiButton type="button" variant="outline" @click="authUrl && copyText(authUrl, 'link')">
                  <UiIcon :name="copiedLink ? 'i-lucide-check' : 'i-lucide-copy'" class="size-4" />
                </UiButton>
              </UiTooltip>
            </div>
          </template>

          <div v-if="errorMessage" class="relative w-full rounded-lg border border-destructive/50 px-4 py-3 text-sm text-destructive">
            <UiIcon name="i-lucide-alert-circle" class="absolute left-4 top-4 size-4" />
            <div class="pl-7 text-xs">{{ errorMessage }}</div>
          </div>
        </div>

        <form v-if="step === finishStep && selectedConfig && activeFlowType === 'oauth_redirect'" class="space-y-4" @submit.prevent>
          <div class="space-y-2">
            <label for="callback-url" class="text-sm font-medium">
              Paste Callback URL <span aria-hidden="true" class="text-destructive">*</span>
            </label>
            <p class="text-sm text-muted-foreground">Paste the URL from your browser after the OAuth redirect.</p>
            <div class="relative">
              <input
                id="callback-url"
                v-model="callbackUrl"
                type="text"
                :placeholder="callbackPlaceholder(provider)"
                :disabled="isLoading"
                class="h-9 w-full rounded-md border border-input bg-background px-3 pr-9 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
                @input="handleCallbackInput"
                @paste="handleCallbackPaste"
              >
              <UiTooltip :text="copiedCallbackUrl ? 'Pasted' : 'Paste'">
                <button
                  type="button"
                  :disabled="isLoading"
                  class="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                  aria-label="Paste callback URL"
                  @click="pasteCallbackUrl"
                >
                  <UiIcon :name="isLoading ? 'i-lucide-loader-2' : copiedCallbackUrl ? 'i-lucide-check' : 'i-lucide-clipboard-paste'" :class="['size-4', isLoading ? 'animate-spin' : '']" />
                </button>
              </UiTooltip>
            </div>
            <p v-if="errorMessage" class="text-sm text-destructive">{{ errorMessage }}</p>
          </div>
        </form>

        <form
          v-if="step === finishStep && selectedConfig && activeFlowType === 'chatgpt_session'"
          class="space-y-4"
          autocomplete="off"
          data-lpignore="true"
          data-1p-ignore="true"
          @submit.prevent="handleConnectCodexSession"
        >
          <div class="space-y-2">
            <label for="chatgpt-session-json" class="text-sm font-medium">
              Paste Session <span aria-hidden="true" class="text-destructive">*</span>
            </label>
            <p class="text-sm text-muted-foreground">Paste the full response from <code class="rounded bg-muted px-1">chatgpt.com/api/auth/session</code>.</p>
            <textarea
              id="chatgpt-session-json"
              v-model="chatgptSessionJson"
              name="chatgpt-session-json"
              autocomplete="off"
              autocorrect="off"
              autocapitalize="none"
              spellcheck="false"
              data-lpignore="true"
              data-1p-ignore="true"
              :disabled="isLoading"
              :placeholder="chatgptSessionPlaceholder"
              class="min-h-36 w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
            />
          </div>

          <p v-if="errorMessage" class="text-sm text-destructive">{{ errorMessage }}</p>

          <UiButton type="submit" class="w-full" :disabled="isLoading">
            <UiIcon v-if="isLoading" name="i-lucide-loader-2" class="size-4 animate-spin" />
            {{ isLoading ? 'Connecting...' : 'Connect Codex Account' }}
          </UiButton>
        </form>

        <form
          v-if="step === finishStep && selectedConfig && (activeFlowType === 'api_key' || activeFlowType === 'api_key_with_account_id')"
          class="space-y-4"
          autocomplete="off"
          data-lpignore="true"
          data-1p-ignore="true"
          @submit.prevent="handleConnectApiKey"
        >
          <div class="space-y-2">
            <p class="text-sm font-medium">Connect {{ selectedConfig.name }}</p>
            <p class="text-sm text-muted-foreground">
              {{ activeFlowType === 'api_key_with_account_id' ? 'Paste your API token and Account ID. Credentials will be stored encrypted.' : 'Paste your provider API key directly. The key will be stored encrypted.' }}
            </p>
          </div>

          <div class="space-y-2">
            <label for="provider-api-key" class="text-sm font-medium">
              {{ activeFlowType === 'api_key_with_account_id' ? 'API Token' : 'API Key' }} <span aria-hidden="true" class="text-destructive">*</span>
            </label>
            <div class="relative">
              <input
                id="provider-api-key"
                v-model="apiKey"
                type="text"
                name="provider-token"
                autocomplete="off"
                autocorrect="off"
                autocapitalize="none"
                spellcheck="false"
                data-lpignore="true"
                data-1p-ignore="true"
                :placeholder="selectedConfig.apiKeyPlaceholder"
                :disabled="isLoading"
                :class="cn(
                  'h-9 w-full rounded-md border border-input bg-background px-3 pr-9 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50',
                  isApiKeyVisible ? '' : '[text-security:disc] [-webkit-text-security:disc]',
                )"
              >
              <UiTooltip :text="isApiKeyVisible ? 'Hide' : 'Show'">
                <button
                  type="button"
                  :disabled="isLoading"
                  class="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                  :aria-label="isApiKeyVisible ? 'Hide API key' : 'Show API key'"
                  @click="isApiKeyVisible = !isApiKeyVisible"
                >
                  <UiIcon :name="isApiKeyVisible ? 'i-lucide-eye-off' : 'i-lucide-eye'" class="size-4" />
                </button>
              </UiTooltip>
            </div>
          </div>

          <div v-if="provider === 'zenmux'" class="space-y-2">
            <label for="provider-platform-key" class="text-sm font-medium">
              Platform Key <span aria-hidden="true" class="text-destructive">*</span>
            </label>
            <p class="text-xs text-muted-foreground">
              For quota usage tracking.
              <a href="https://zenmux.ai/platform/management" target="_blank" class="underline">Get from ZenMux → Management → API Keys</a>
            </p>
            <input
              id="provider-platform-key"
              v-model="platformKey"
              type="text"
              name="provider-platform-key"
              autocomplete="off"
              autocorrect="off"
              autocapitalize="none"
              spellcheck="false"
              data-lpignore="true"
              data-1p-ignore="true"
              placeholder="sk-mg-v1-..."
              :disabled="isLoading"
              class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
            >
          </div>

          <div v-if="activeFlowType === 'api_key_with_account_id'" class="space-y-2">
            <label for="provider-account-id" class="text-sm font-medium">
              {{ selectedConfig.accountIdLabel }} <span aria-hidden="true" class="text-destructive">*</span>
            </label>
            <input
              id="provider-account-id"
              v-model="cfAccountId"
              type="text"
              name="provider-account-id"
              autocomplete="off"
              autocorrect="off"
              autocapitalize="none"
              spellcheck="false"
              data-lpignore="true"
              data-1p-ignore="true"
              :placeholder="selectedConfig.accountIdPlaceholder"
              :disabled="isLoading"
              class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
            >
          </div>

          <p v-if="errorMessage" class="text-sm text-destructive">{{ errorMessage }}</p>

          <UiButton type="submit" class="w-full" :disabled="isLoading">
            <UiIcon v-if="isLoading" name="i-lucide-loader-2" class="size-4 animate-spin" />
            {{ isLoading ? 'Connecting...' : `Connect ${selectedConfig.name} Account` }}
          </UiButton>
        </form>
      </div>

      <div class="flex flex-row items-center justify-between gap-2">
        <UiButton v-if="isPolling" type="button" variant="ghost" @click="goBackFromDevicePolling">
          <UiIcon name="i-lucide-arrow-left" class="size-4" />
          Back
        </UiButton>

        <UiButton v-if="step > minimumStep && !isPolling" type="button" variant="ghost" :disabled="isLoading" @click="goBack">
          <UiIcon name="i-lucide-arrow-left" class="size-4" />
          Back
        </UiButton>

        <UiButton v-if="step === authStep && selectedConfig && activeFlowType !== 'device_code'" type="button" variant="ghost" class="ml-auto" @click="step = finishStep">
          Next
          <UiIcon name="i-lucide-arrow-right" class="size-4" />
        </UiButton>
      </div>
      </template>
      <CustomProviderSetup v-else @cancel="customMode = false" @created="handleCustomCreated" />
    </template>
  </UiDialog>
</template>
