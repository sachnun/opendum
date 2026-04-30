<script setup lang="ts">
import type { ProviderAccountKey } from "../../lib/provider-accounts";

type Provider = ProviderAccountKey;
type FlowType = "oauth_redirect" | "device_code" | "api_key" | "api_key_with_account_id";

interface ProviderConfig {
  name: string;
  description: string;
  flowType: FlowType;
  apiKeyPortalUrl?: string;
  apiKeyPlaceholder?: string;
  accountIdPlaceholder?: string;
  accountIdLabel?: string;
}

const props = withDefaults(
  defineProps<{
    initialProvider?: Provider | null;
    triggerClass?: string;
  }>(),
  {
    initialProvider: null,
    triggerClass: "",
  }
);

const emit = defineEmits<{
  connected: [];
}>();

const { $client } = useNuxtApp();

const providerConfigs: Record<Provider, ProviderConfig> = {
  antigravity: { name: "Antigravity", description: "Access Gemini & Claude via Google OAuth", flowType: "oauth_redirect" },
  gemini_cli: { name: "Gemini CLI", description: "Access Gemini 2.5 Pro & 3 models", flowType: "oauth_redirect" },
  qwen_code: { name: "Qwen Code", description: "Access Qwen Coder models", flowType: "device_code" },
  copilot: { name: "Copilot", description: "Access GitHub Copilot chat models", flowType: "device_code" },
  codex: { name: "Codex", description: "Access GPT-5 Codex models", flowType: "oauth_redirect" },
  kiro: { name: "Kiro", description: "Access Claude via Kiro OAuth", flowType: "oauth_redirect" },
  nvidia_nim: { name: "Nvidia", description: "Access NIM models with direct API key", flowType: "api_key", apiKeyPortalUrl: "https://build.nvidia.com/settings/api-keys", apiKeyPlaceholder: "nvapi-..." },
  ollama_cloud: { name: "Ollama Cloud", description: "Access Ollama Cloud via OpenAI-compatible API", flowType: "api_key", apiKeyPortalUrl: "https://ollama.com/settings/keys", apiKeyPlaceholder: "ollama_..." },
  openrouter: { name: "OpenRouter", description: "Access OpenRouter free models via API key", flowType: "api_key", apiKeyPortalUrl: "https://openrouter.ai/settings/keys", apiKeyPlaceholder: "sk-or-v1-..." },
  groq: { name: "Groq", description: "Access ultra-fast LLM inference via Groq API", flowType: "api_key", apiKeyPortalUrl: "https://console.groq.com/keys", apiKeyPlaceholder: "gsk_..." },
  cerebras: { name: "Cerebras", description: "Access ultra-fast open-source models via Cerebras API", flowType: "api_key", apiKeyPortalUrl: "https://cloud.cerebras.ai", apiKeyPlaceholder: "csk-..." },
  kilo_code: { name: "Kilo Code", description: "Access free & auto-routed models via Kilo Gateway", flowType: "api_key", apiKeyPortalUrl: "https://app.kilo.ai", apiKeyPlaceholder: "sk-..." },
  workers_ai: { name: "Workers AI", description: "Access open-source models on Cloudflare's global network", flowType: "api_key_with_account_id", apiKeyPortalUrl: "https://dash.cloudflare.com/?to=/:account/ai/workers-ai", apiKeyPlaceholder: "Bearer token...", accountIdPlaceholder: "e.g. 1a2b3c4d5e6f...", accountIdLabel: "Cloudflare Account ID" },
};

const oauthProviders: Provider[] = ["antigravity", "codex", "kiro", "gemini_cli", "qwen_code", "copilot"];
const apiKeyProviders: Provider[] = ["ollama_cloud", "openrouter", "nvidia_nim", "groq", "cerebras", "kilo_code", "workers_ai"];
const minimumStep = computed(() => (props.initialProvider ? 2 : 1));

const open = ref(false);
const step = ref(minimumStep.value);
const provider = ref<Provider | null>(props.initialProvider);
const callbackUrl = ref("");
const apiKey = ref("");
const cfAccountId = ref("");
const accountName = ref("");
const authUrl = ref("");
const oauthState = ref<string | null>(null);
const oauthCodeVerifier = ref<string | null>(null);
const deviceCodeInfo = ref<{ provider: "qwen_code" | "copilot"; deviceCode: string; userCode: string; verificationUrl: string; codeVerifier?: string } | null>(null);
const copiedLink = ref(false);
const copiedDeviceCode = ref(false);
const isApiKeyVisible = ref(false);
const isLoading = ref(false);
const isPolling = ref(false);
const errorMessage = ref("");
let pollingTimer: ReturnType<typeof setTimeout> | null = null;

const selectedConfig = computed(() => (provider.value ? providerConfigs[provider.value] : null));
const selectedProviderLabel = computed(() => selectedConfig.value?.name ?? "provider");
const dialogTitle = computed(() => {
  if (step.value === 1) return "Add Provider Account";
  return `Connect ${selectedProviderLabel.value}`;
});

watch(open, (value) => {
  if (!value) resetForm();
});

watch([open, step, provider], async () => {
  if (!open.value || step.value !== 2 || !provider.value || !selectedConfig.value) return;

  errorMessage.value = "";
  authUrl.value = "";
  deviceCodeInfo.value = null;

  try {
    if (selectedConfig.value.flowType === "oauth_redirect") {
      isLoading.value = true;
      const result = await $client.accounts.getAuthUrl.mutate({ provider: provider.value as "antigravity" | "gemini_cli" | "codex" | "kiro" });
      if (!result.success) throw new Error(result.error);
      authUrl.value = result.data.authUrl;
      oauthState.value = result.data.state;
      oauthCodeVerifier.value = result.data.codeVerifier;
      return;
    }

    if (selectedConfig.value.flowType === "device_code") {
      isLoading.value = true;
      const result = await $client.accounts.initiateDeviceAuth.mutate({ provider: provider.value as "qwen_code" | "copilot" });
      if (!result.success) throw new Error(result.error);
      deviceCodeInfo.value = {
        provider: provider.value as "qwen_code" | "copilot",
        deviceCode: result.data.deviceCode,
        userCode: result.data.userCode,
        verificationUrl: result.data.verificationUrlComplete || result.data.verificationUrl,
        codeVerifier: "codeVerifier" in result.data ? result.data.codeVerifier : undefined,
      };
      authUrl.value = deviceCodeInfo.value.verificationUrl;
      return;
    }

    authUrl.value = selectedConfig.value.apiKeyPortalUrl ?? "";
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Failed to start account connection";
  } finally {
    isLoading.value = false;
  }
});

function resetForm() {
  step.value = minimumStep.value;
  provider.value = props.initialProvider;
  callbackUrl.value = "";
  apiKey.value = "";
  cfAccountId.value = "";
  accountName.value = "";
  authUrl.value = "";
  oauthState.value = null;
  oauthCodeVerifier.value = null;
  deviceCodeInfo.value = null;
  copiedLink.value = false;
  copiedDeviceCode.value = false;
  isApiKeyVisible.value = false;
  isLoading.value = false;
  isPolling.value = false;
  errorMessage.value = "";
  if (pollingTimer) {
    clearTimeout(pollingTimer);
    pollingTimer = null;
  }
}

function selectProvider(providerKey: Provider) {
  provider.value = providerKey;
  step.value = 2;
}

async function copyText(value: string, target: "link" | "code") {
  await navigator.clipboard.writeText(value);
  if (target === "link") {
    copiedLink.value = true;
    setTimeout(() => (copiedLink.value = false), 1500);
  } else {
    copiedDeviceCode.value = true;
    setTimeout(() => (copiedDeviceCode.value = false), 1500);
  }

  if (target === "link" && selectedConfig.value?.flowType === "device_code") {
    startDevicePolling();
  }
}

function openPopup(url: string, name: string, width: number, height: number) {
  const left = Math.round((window.screen.width - width) / 2);
  const top = Math.round((window.screen.height - height) / 2);
  const popup = window.open(url, name, `width=${width},height=${height},left=${left},top=${top},scrollbars=yes,resizable=yes`);
  if (!popup || popup.closed) window.open(url, "_blank");
}

function openOAuthUrl() {
  if (!authUrl.value) return;
  openPopup(authUrl.value, "oauth_popup", 600, 700);
}

function openDeviceAuthUrl() {
  if (!authUrl.value) return;
  openPopup(authUrl.value, "device_auth_popup", 600, 700);
  startDevicePolling();
}

function openApiKeyPortal() {
  if (!authUrl.value) return;
  openPopup(authUrl.value, "api_key_portal_popup", 1100, 760);
}

function startDevicePolling() {
  if (!deviceCodeInfo.value || isPolling.value) return;

  isPolling.value = true;
  errorMessage.value = "";
  const startedAt = Date.now();
  let intervalMs = 8000;

  const stopPolling = () => {
    isPolling.value = false;
    if (pollingTimer) {
      clearTimeout(pollingTimer);
      pollingTimer = null;
    }
  };

  const poll = async () => {
    if (!deviceCodeInfo.value) return;

    if (Date.now() - startedAt >= 900_000) {
      errorMessage.value = "Device code expired. Please try again.";
      stopPolling();
      return;
    }

    try {
      const result = await $client.accounts.pollDeviceAuth.mutate({
        provider: deviceCodeInfo.value.provider,
        deviceCode: deviceCodeInfo.value.deviceCode,
        codeVerifier: deviceCodeInfo.value.codeVerifier,
      });

      if (!result.success) throw new Error(result.error);

      if (result.data.status === "success") {
        stopPolling();
        open.value = false;
        emit("connected");
        return;
      }

      if (result.data.status === "error") {
        errorMessage.value = result.data.message;
        stopPolling();
        return;
      }

      if (typeof result.data.retryAfterSeconds === "number" && result.data.retryAfterSeconds > 0) {
        intervalMs = result.data.retryAfterSeconds * 1000;
      }
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : "Failed to check authorization status";
    }

    pollingTimer = setTimeout(poll, intervalMs);
  };

  pollingTimer = setTimeout(poll, intervalMs);
}

async function handleConnectApiKey() {
  if (!provider.value) return;
  isLoading.value = true;
  errorMessage.value = "";
  try {
    const result = await $client.accounts.create.mutate({ provider: provider.value, name: accountName.value || undefined, token: apiKey.value, cfAccountId: cfAccountId.value || undefined });
    if (!result.success) throw new Error(result.error);
    open.value = false;
    emit("connected");
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Failed to connect account";
  } finally {
    isLoading.value = false;
  }
}

async function handleExchangeOAuth() {
  if (!provider.value) return;
  isLoading.value = true;
  errorMessage.value = "";
  try {
    const result = await $client.accounts.exchangeOAuth.mutate({ provider: provider.value as "antigravity" | "gemini_cli" | "codex" | "kiro", callbackUrl: callbackUrl.value, state: oauthState.value, codeVerifier: oauthCodeVerifier.value });
    if (!result.success) throw new Error(result.error);
    open.value = false;
    emit("connected");
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Failed to connect account";
  } finally {
    isLoading.value = false;
  }
}

onBeforeUnmount(() => {
  if (pollingTimer) {
    clearTimeout(pollingTimer);
    pollingTimer = null;
  }
});
</script>

<template>
  <UiButton :class="triggerClass" @click="open = true">
    <UIcon name="i-lucide-plus" class="size-4" />
    Add account
  </UiButton>

  <UModal v-model:open="open" :ui="{ content: 'sm:max-w-[560px]' }">
    <template #content>
      <div class="space-y-1.5 pr-6">
        <h2 class="text-lg font-semibold leading-none tracking-tight">{{ dialogTitle }}</h2>
        <p class="text-sm text-muted-foreground">
          {{ step === 1 ? 'Choose a provider to connect.' : selectedConfig?.description }}
        </p>
      </div>

      <div v-if="errorMessage" class="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {{ errorMessage }}
      </div>

      <div v-if="step === 1" class="max-h-[60vh] space-y-5 overflow-y-auto pr-1">
        <div>
          <p class="mb-2 text-xs font-medium text-muted-foreground">OAuth Providers</p>
          <div class="grid gap-2 sm:grid-cols-2">
            <button v-for="providerKey in oauthProviders" :key="providerKey" type="button" class="rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-primary/40 hover:bg-accent/40" @click="selectProvider(providerKey)">
              <p class="font-medium">{{ providerConfigs[providerKey].name }}</p>
              <p class="mt-1 text-xs text-muted-foreground">{{ providerConfigs[providerKey].description }}</p>
            </button>
          </div>
        </div>
        <div>
          <p class="mb-2 text-xs font-medium text-muted-foreground">API Key Providers</p>
          <div class="grid gap-2 sm:grid-cols-2">
            <button v-for="providerKey in apiKeyProviders" :key="providerKey" type="button" class="rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-primary/40 hover:bg-accent/40" @click="selectProvider(providerKey)">
              <p class="font-medium">{{ providerConfigs[providerKey].name }}</p>
              <p class="mt-1 text-xs text-muted-foreground">{{ providerConfigs[providerKey].description }}</p>
            </button>
          </div>
        </div>
      </div>

      <div v-else-if="selectedConfig" class="space-y-4">
        <button v-if="!initialProvider" type="button" class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" @click="step = 1">
          <UIcon name="i-lucide-arrow-left" class="size-4" />
          Back
        </button>

        <template v-if="selectedConfig.flowType === 'oauth_redirect'">
          <div class="space-y-2">
            <UiButton as="a" type="button" variant="outline" class="w-full justify-between" :disabled="isLoading || !authUrl" @click="openOAuthUrl">
              <span class="inline-flex items-center gap-2">
                <UIcon name="i-lucide-external-link" class="size-4" />
                Open login page
              </span>
              <UIcon v-if="isLoading" name="i-lucide-loader-2" class="size-4 animate-spin" />
            </UiButton>
            <UiButton variant="ghost" size="sm" class="w-full" :disabled="!authUrl" @click="copyText(authUrl, 'link')">
              <UIcon :name="copiedLink ? 'i-lucide-check' : 'i-lucide-copy'" class="size-4" />
              {{ copiedLink ? 'Copied login link' : 'Copy login link' }}
            </UiButton>
          </div>
          <label class="grid gap-1 text-sm font-medium">
            Callback URL
            <textarea v-model="callbackUrl" rows="3" placeholder="Paste the localhost callback URL here" class="rounded-md border border-input bg-background px-3 py-2 text-sm font-mono outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" />
          </label>
          <div class="flex justify-end">
            <UiButton :disabled="isLoading || !callbackUrl" @click="handleExchangeOAuth">
              <UIcon v-if="isLoading" name="i-lucide-loader-2" class="size-4 animate-spin" />
              Connect account
            </UiButton>
          </div>
        </template>

        <template v-else-if="selectedConfig.flowType === 'device_code'">
          <div class="rounded-lg border border-border bg-muted/20 p-3">
            <p class="text-sm text-muted-foreground">Open the verification link and enter this code. Authorization will be detected automatically.</p>
            <div class="mt-3 flex items-center justify-between gap-3 rounded-md bg-background px-3 py-2 font-mono text-lg font-semibold tracking-wider">
              <span>{{ deviceCodeInfo?.userCode ?? 'Loading...' }}</span>
              <UiButton variant="ghost" size="icon-sm" :disabled="!deviceCodeInfo" @click="deviceCodeInfo && copyText(deviceCodeInfo.userCode, 'code')">
                <UIcon :name="copiedDeviceCode ? 'i-lucide-check' : 'i-lucide-copy'" class="size-4" />
              </UiButton>
            </div>
          </div>
          <div class="flex gap-2">
            <UiButton variant="outline" class="flex-1" :disabled="isLoading || !authUrl || isPolling" @click="openDeviceAuthUrl">
              <UIcon :name="isPolling ? 'i-lucide-loader-2' : 'i-lucide-external-link'" :class="['size-4', isPolling ? 'animate-spin' : '']" />
              {{ isPolling ? 'Waiting for login...' : 'Open verification page' }}
            </UiButton>
            <UiButton variant="outline" :disabled="!authUrl" :title="copiedLink ? 'Copied!' : 'Copy verification link'" @click="copyText(authUrl, 'link')">
              <UIcon :name="copiedLink ? 'i-lucide-check' : 'i-lucide-copy'" class="size-4" />
            </UiButton>
          </div>
          <div v-if="isPolling" class="rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            Complete the login in your browser. This dialog will close automatically when authorization is complete.
          </div>
        </template>

        <template v-else>
          <UiButton v-if="authUrl" variant="outline" class="w-full" @click="openApiKeyPortal">
            <UIcon name="i-lucide-external-link" class="size-4" />
            Open API key portal
          </UiButton>
          <label class="grid gap-1 text-sm font-medium">
            Account name
            <input v-model="accountName" placeholder="Optional display name" class="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
          </label>
          <label v-if="selectedConfig.flowType === 'api_key_with_account_id'" class="grid gap-1 text-sm font-medium">
            {{ selectedConfig.accountIdLabel }}
            <input v-model="cfAccountId" :placeholder="selectedConfig.accountIdPlaceholder" class="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
          </label>
          <label class="grid gap-1 text-sm font-medium">
            API key
            <div class="relative">
              <input v-model="apiKey" :type="isApiKeyVisible ? 'text' : 'password'" :placeholder="selectedConfig.apiKeyPlaceholder" class="h-9 w-full rounded-md border border-input bg-background px-3 pr-10 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
              <button type="button" class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" @click="isApiKeyVisible = !isApiKeyVisible">
                <UIcon :name="isApiKeyVisible ? 'i-lucide-eye-off' : 'i-lucide-eye'" class="size-4" />
              </button>
            </div>
          </label>
          <div class="flex justify-end">
            <UiButton :disabled="isLoading || !apiKey || (selectedConfig.flowType === 'api_key_with_account_id' && !cfAccountId)" @click="handleConnectApiKey">
              <UIcon v-if="isLoading" name="i-lucide-loader-2" class="size-4 animate-spin" />
              Connect account
            </UiButton>
          </div>
        </template>
      </div>
    </template>
  </UModal>
</template>
