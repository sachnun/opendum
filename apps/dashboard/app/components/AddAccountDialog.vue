<script setup lang="ts">
import type { ProviderAccountKey } from "../../lib/provider-accounts";
import { cn } from "../../lib/utils";

type Provider = ProviderAccountKey;
type FlowType = "oauth_redirect" | "device_code" | "chatgpt_session" | "api_key" | "api_key_with_account_id";
type CopilotAuthMethod = "opencode" | "official";
type MethodKey = FlowType | "copilot_device_code_opencode" | "copilot_device_code_official";

interface ProviderMethod {
  key: MethodKey;
  flow?: FlowType;
  copilotAuthMethod?: CopilotAuthMethod;
  name: string;
  tag?: string;
  description: string;
  disabled?: boolean;
}

interface ProviderConfig {
  name: string;
  description: string;
  methods: ProviderMethod[];
  apiKeyPortalUrl?: string;
  apiKeyPlaceholder?: string;
  accountIdPlaceholder?: string;
  accountIdLabel?: string;
}

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
}>();

const dashboardApi = useDashboardApi();
const dashboardInvalidation = useDashboardDataInvalidation();

const browserOAuthMethod: ProviderMethod = { key: "oauth_redirect", name: "Browser OAuth", description: "Login in your browser." };
const deviceCodeMethod: ProviderMethod = { key: "device_code", name: "Device Code", description: "Enter a short device code." };
const copilotOpencodeMethod: ProviderMethod = { key: "copilot_device_code_opencode", flow: "device_code", copilotAuthMethod: "opencode", name: "Device Code", tag: "Opencode", description: "Use the Opencode OAuth app." };
const copilotOfficialMethod: ProviderMethod = { key: "copilot_device_code_official", flow: "device_code", copilotAuthMethod: "official", name: "Device Code", description: "Use the GitHub Copilot OAuth app." };
const apiKeyMethod: ProviderMethod = { key: "api_key", name: "API Key", description: "Create or copy an API key from the provider portal." };
const apiTokenWithAccountIdMethod: ProviderMethod = { key: "api_key_with_account_id", name: "API Token", description: "Requires the matching account ID." };

const providerConfigs: Record<Provider, ProviderConfig> = {
  antigravity: { name: "Antigravity", description: "Access Gemini & Claude via Google OAuth", methods: [browserOAuthMethod] },
  qwen_code: { name: "Qwen Code", description: "Access Qwen Coder models", methods: [deviceCodeMethod] },
  copilot: { name: "Copilot", description: "Access GitHub Copilot chat models", methods: [copilotOpencodeMethod, copilotOfficialMethod] },
  codex: { name: "Codex", description: "Access GPT-5 Codex models", methods: [browserOAuthMethod, deviceCodeMethod, { key: "chatgpt_session", name: "ChatGPT Session", description: "Use an active web session.", disabled: true }] },
  kiro: { name: "Kiro", description: "Access Claude via Kiro OAuth", methods: [browserOAuthMethod] },
  nvidia_nim: { name: "Nvidia", description: "Access NIM models with direct API key", methods: [apiKeyMethod], apiKeyPortalUrl: "https://build.nvidia.com/settings/api-keys", apiKeyPlaceholder: "nvapi-..." },
  openrouter: { name: "Openrouter", description: "Access Openrouter free models via API key", methods: [apiKeyMethod], apiKeyPortalUrl: "https://openrouter.ai/settings/keys", apiKeyPlaceholder: "sk-or-v1-..." },
  workers_ai: { name: "Cloudflare", description: "Access open-source models on Cloudflare's global network", methods: [apiTokenWithAccountIdMethod], apiKeyPortalUrl: "https://dash.cloudflare.com/?to=/:account/ai/workers-ai", apiKeyPlaceholder: "Bearer token...", accountIdPlaceholder: "e.g. 1a2b3c4d5e6f...", accountIdLabel: "Cloudflare Account ID" },
  qoder: { name: "Qoder", description: "Access Qoder models via PAT", methods: [apiKeyMethod], apiKeyPortalUrl: "https://qoder.com/account/integrations", apiKeyPlaceholder: "qod_pat_..." },
  zenmux: { name: "ZenMux", description: "Access ZenMux free models via API key", methods: [apiKeyMethod], apiKeyPortalUrl: "https://zenmux.ai/platform/pay-as-you-go", apiKeyPlaceholder: "sk-..." },
  siliconflow: { name: "SiliconFlow", description: "Access DeepSeek, Qwen, GLM & more via API key", methods: [apiKeyMethod], apiKeyPortalUrl: "https://cloud.siliconflow.com/account/ak", apiKeyPlaceholder: "sk-..." },
};

const chatgptSessionPlaceholder = `{
  "WARNING_BANNER": "!!!!!!!!!!!!!!!!!!!! DO NOT SHARE ANY PART OF THE INFORMATION YOU SEE HERE. THIS INFORMATION IS SENSITIVE AND CAN GRANT ACCESS TO YOUR ACCOUNT. !!!!!!!!!!!!!!!!!!!!",
  "user": {
    "email": "you@example.com"
  },
  "expires": "2026-08-16T22:42:05.747Z",
  "account": {
    "id": "b975c0c5-b667-4aa8-ac89-ce4ec41c6357",
    "planType": "free"
  },
  "accessToken": "eyJ...",
  "authProvider": "openai",
  "sessionToken": "eyJ..."
}`;

const providerOptions: Provider[] = ["antigravity", "codex", "kiro", "qwen_code", "copilot", "openrouter", "nvidia_nim", "workers_ai", "qoder", "zenmux", "siliconflow"];

const open = ref(false);
const minimumStep = computed(() => (props.initialProvider ? 2 : 1));
const step = ref(minimumStep.value);
const provider = ref<Provider | null>(props.initialProvider);
const callbackUrl = ref("");
const chatgptSessionJson = ref("");
const apiKey = ref("");
const cfAccountId = ref("");
const authUrl = ref("");
const oauthState = ref<string | null>(null);
const oauthCodeVerifier = ref<string | null>(null);
const selectedMethod = ref<MethodKey | null>(null);
const deviceCodeInfo = ref<{ provider: "qwen_code" | "copilot" | "codex"; deviceCode: string; userCode: string; verificationUrl: string; codeVerifier?: string; method?: CopilotAuthMethod } | null>(null);
const copiedLink = ref(false);
const copiedDeviceCode = ref(false);
const copiedCallbackUrl = ref(false);
const isApiKeyVisible = ref(false);
const isLoading = ref(false);
const isFetchingUrl = ref(false);
const isPolling = ref(false);
const errorMessage = ref("");
let pollingTimer: ReturnType<typeof setTimeout> | null = null;
let copiedLinkTimer: ReturnType<typeof setTimeout> | null = null;
let copiedDeviceCodeTimer: ReturnType<typeof setTimeout> | null = null;
let copiedCallbackUrlTimer: ReturnType<typeof setTimeout> | null = null;
let copyAutoNextTimer: ReturnType<typeof setTimeout> | null = null;
let callbackAutoExchangeTimer: ReturnType<typeof setTimeout> | null = null;

const selectedConfig = computed(() => (provider.value ? providerConfigs[provider.value] : null));
const activeFlowType = computed<FlowType | null>(() => {
  if (!selectedConfig.value || !selectedMethod.value) return null;
  const method = selectedConfig.value.methods.find((item) => item.key === selectedMethod.value && !item.disabled);
  if (!method) return null;
  return method.flow ?? (method.key as FlowType);
});
const selectedCopilotAuthMethod = computed<CopilotAuthMethod | undefined>(() => {
  if (provider.value !== "copilot" || !selectedConfig.value || !selectedMethod.value) return undefined;
  return selectedConfig.value.methods.find((item) => item.key === selectedMethod.value)?.copilotAuthMethod;
});
const authStep = computed(() => 3);
const finishStep = computed(() => 4);
const dialogOpen = computed({
  get: () => open.value,
  set: (value: boolean) => {
    if (!value && isLoading.value) return;
    open.value = value;
  },
});
const displayedSteps = computed(() => {
  return props.initialProvider ? [2, 3, 4] : [1, 2, 3, 4];
});
const shouldPreventOutsideClose = computed(() => {
  const flowType = activeFlowType.value;
  return isPolling.value || (step.value === authStep.value && (flowType === "api_key" || flowType === "api_key_with_account_id" || flowType === "chatgpt_session")) || (step.value === finishStep.value && flowType === "oauth_redirect");
});

watch(open, (value) => {
  if (value) {
    step.value = minimumStep.value;
    provider.value = props.initialProvider;
    selectedMethod.value = null;
    return;
  }

  resetForm();
});

watch([open, step, provider, selectedMethod], async () => {
  if (props.readonly) return;
  if (!open.value || step.value !== authStep.value || !provider.value || !selectedConfig.value || !activeFlowType.value) return;

  const selectedProvider = provider.value;
  const selectedFlowType = activeFlowType.value;
  const selectedStep = step.value;

  errorMessage.value = "";
  authUrl.value = "";
  oauthState.value = null;
  oauthCodeVerifier.value = null;
  deviceCodeInfo.value = null;
  isFetchingUrl.value = true;

  try {
    if (selectedFlowType === "oauth_redirect") {
      const result = await dashboardApi.accounts.getAuthUrl({ provider: selectedProvider as "antigravity" | "codex" | "kiro" });
      if (!result.success) throw new Error(result.error);
      if (provider.value !== selectedProvider || activeFlowType.value !== selectedFlowType || step.value !== selectedStep) return;
      authUrl.value = result.data.authUrl;
      oauthState.value = result.data.state;
      oauthCodeVerifier.value = result.data.codeVerifier;
      return;
    }

    if (selectedFlowType === "device_code") {
      const method = selectedProvider === "copilot" ? selectedCopilotAuthMethod.value : undefined;
      const result = await dashboardApi.accounts.initiateDeviceAuth({ provider: selectedProvider as "qwen_code" | "copilot" | "codex", method });
      if (!result.success) throw new Error(result.error);
      if (provider.value !== selectedProvider || activeFlowType.value !== selectedFlowType || step.value !== selectedStep) return;
      deviceCodeInfo.value = {
        provider: selectedProvider as "qwen_code" | "copilot" | "codex",
        deviceCode: result.data.deviceCode,
        userCode: result.data.userCode,
        verificationUrl: result.data.verificationUrlComplete || result.data.verificationUrl,
        codeVerifier: "codeVerifier" in result.data && typeof result.data.codeVerifier === "string" ? result.data.codeVerifier : undefined,
        method,
      };
      return;
    }

    authUrl.value = providerConfigs[selectedProvider].apiKeyPortalUrl ?? "";
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Failed to start account connection";
  } finally {
    if (provider.value === selectedProvider && activeFlowType.value === selectedFlowType && step.value === selectedStep) {
      isFetchingUrl.value = false;
    }
  }
});

function resetForm() {
  step.value = minimumStep.value;
  provider.value = props.initialProvider;
  callbackUrl.value = "";
  chatgptSessionJson.value = "";
  apiKey.value = "";
  cfAccountId.value = "";
  authUrl.value = "";
  oauthState.value = null;
  oauthCodeVerifier.value = null;
  selectedMethod.value = null;
  deviceCodeInfo.value = null;
  copiedLink.value = false;
  copiedDeviceCode.value = false;
  copiedCallbackUrl.value = false;
  isApiKeyVisible.value = false;
  isLoading.value = false;
  isFetchingUrl.value = false;
  isPolling.value = false;
  errorMessage.value = "";
  if (pollingTimer) {
    clearTimeout(pollingTimer);
    pollingTimer = null;
  }
  if (copiedLinkTimer) {
    clearTimeout(copiedLinkTimer);
    copiedLinkTimer = null;
  }
  if (copiedDeviceCodeTimer) {
    clearTimeout(copiedDeviceCodeTimer);
    copiedDeviceCodeTimer = null;
  }
  if (copiedCallbackUrlTimer) {
    clearTimeout(copiedCallbackUrlTimer);
    copiedCallbackUrlTimer = null;
  }
  if (copyAutoNextTimer) {
    clearTimeout(copyAutoNextTimer);
    copyAutoNextTimer = null;
  }
  clearCallbackAutoExchangeTimer();
}

function clearCopyAutoNextTimer() {
  if (!copyAutoNextTimer) return;
  clearTimeout(copyAutoNextTimer);
  copyAutoNextTimer = null;
}

function clearCallbackAutoExchangeTimer() {
  if (!callbackAutoExchangeTimer) return;
  clearTimeout(callbackAutoExchangeTimer);
  callbackAutoExchangeTimer = null;
}

function finishConnection(result: { email: string; isUpdate: boolean }) {
  const connectedProvider = provider.value;
  if (!connectedProvider) return;

  open.value = false;
  emit("connected", { provider: connectedProvider, ...result });
  void dashboardInvalidation.invalidateAccountCollection(connectedProvider);
}

function selectProvider(providerKey: Provider) {
  if (props.readonly) return;
  provider.value = providerKey;
  selectedMethod.value = null;
  step.value = 2;
}

function resetAuthProgress() {
  callbackUrl.value = "";
  chatgptSessionJson.value = "";
  authUrl.value = "";
  oauthState.value = null;
  oauthCodeVerifier.value = null;
  deviceCodeInfo.value = null;
  copiedLink.value = false;
  copiedDeviceCode.value = false;
  copiedCallbackUrl.value = false;
  isFetchingUrl.value = false;
  isPolling.value = false;
  errorMessage.value = "";
  if (pollingTimer) {
    clearTimeout(pollingTimer);
    pollingTimer = null;
  }
}

function stopDevicePolling() {
  isPolling.value = false;
  if (pollingTimer) {
    clearTimeout(pollingTimer);
    pollingTimer = null;
  }
}

function selectLoginMethod(method: MethodKey) {
  if (props.readonly) return;
  if (!selectedConfig.value?.methods.some((item) => item.key === method && !item.disabled)) return;
  resetAuthProgress();
  selectedMethod.value = method;
  step.value = authStep.value;
}

function callbackPlaceholder(providerKey: Provider | null) {
  if (providerKey === "kiro") return "http://localhost:49153/oauth/callback?code=...";
  if (providerKey === "codex") return "http://localhost:1455/auth/callback?code=...";
  return "http://localhost:1/oauth2callback?code=...";
}

async function copyText(value: string, target: "link" | "code") {
  try {
    await navigator.clipboard.writeText(value);
    if (target === "link") {
      copiedLink.value = true;
      if (copiedLinkTimer) clearTimeout(copiedLinkTimer);
      copiedLinkTimer = setTimeout(() => {
        copiedLink.value = false;
        copiedLinkTimer = null;
      }, 2000);
    } else {
      copiedDeviceCode.value = true;
      if (copiedDeviceCodeTimer) clearTimeout(copiedDeviceCodeTimer);
      copiedDeviceCodeTimer = setTimeout(() => {
        copiedDeviceCode.value = false;
        copiedDeviceCodeTimer = null;
      }, 2000);
    }
  } catch {
    errorMessage.value = target === "link" ? "Failed to copy link" : "Failed to copy code";
    return;
  }

  if (target === "link" && activeFlowType.value !== "device_code" && step.value === authStep.value) {
    clearCopyAutoNextTimer();
    copyAutoNextTimer = setTimeout(() => {
      if (step.value === authStep.value && activeFlowType.value !== "device_code") {
        step.value = finishStep.value;
      }
      copyAutoNextTimer = null;
    }, 2000);
  }

  if (target === "link" && activeFlowType.value === "device_code") {
    startDevicePolling(null);
  }
}

function openPopup(url: string, name: string, width: number, height: number) {
  const left = Math.round((window.screen.width - width) / 2);
  const top = Math.round((window.screen.height - height) / 2);
  const popup = window.open(url, name, `width=${width},height=${height},left=${left},top=${top},scrollbars=yes,resizable=yes`);
  if (!popup || popup.closed) {
    window.open(url, "_blank");
    return null;
  }

  return popup;
}

function openOAuthUrl() {
  if (!authUrl.value) return;
  openPopup(authUrl.value, "oauth_popup", 600, 700);
  setTimeout(() => (step.value = finishStep.value), 600);
}

function openDeviceAuthUrl() {
  if (!deviceCodeInfo.value) return;
  const popup = openPopup(deviceCodeInfo.value.verificationUrl, "device_auth_popup", 600, 700);
  startDevicePolling(popup);
}

function openApiKeyPortal() {
  if (!selectedConfig.value?.apiKeyPortalUrl) return;
  openPopup(selectedConfig.value.apiKeyPortalUrl, "api_key_portal_popup", 1100, 760);
  if (step.value === authStep.value) setTimeout(() => (step.value = finishStep.value), 600);
}

function startDevicePolling(popup: Window | null) {
  if (!deviceCodeInfo.value || isPolling.value) return;

  isPolling.value = true;
  errorMessage.value = "";
  const startedAt = Date.now();
  let intervalMs = 8000;

  const stopPolling = (returnToAuthStep = false) => {
    stopDevicePolling();
    if (returnToAuthStep && step.value === finishStep.value && finishStep.value > authStep.value) {
      step.value = authStep.value;
    }
  };

  if (step.value === authStep.value && finishStep.value > authStep.value) {
    step.value = finishStep.value;
  }

  const poll = async () => {
    if (!deviceCodeInfo.value) return;

    if (Date.now() - startedAt >= 900_000) {
      errorMessage.value = "Device code expired. Please try again.";
      stopPolling(true);
      return;
    }

    try {
      const result = await dashboardApi.accounts.pollDeviceAuth({
        provider: deviceCodeInfo.value.provider,
        deviceCode: deviceCodeInfo.value.deviceCode,
        userCode: deviceCodeInfo.value.userCode,
        codeVerifier: deviceCodeInfo.value.codeVerifier,
        method: deviceCodeInfo.value.method,
      });

      if (!result.success) throw new Error(result.error);

      if (result.data.status === "success") {
        if (popup && !popup.closed) popup.close();
        finishConnection({ email: result.data.email, isUpdate: result.data.isUpdate });
        return;
      }

      if (result.data.status === "error") {
        errorMessage.value = result.data.message;
        stopPolling(true);
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
  if (props.readonly) return;
  if (!provider.value || !selectedConfig.value) return;

  errorMessage.value = "";
  if (!apiKey.value.trim()) {
    errorMessage.value = activeFlowType.value === "api_key_with_account_id" ? "Please enter an API token" : "Please enter an API key";
    return;
  }

  if (activeFlowType.value === "api_key_with_account_id" && !cfAccountId.value.trim()) {
    errorMessage.value = `Please enter the ${selectedConfig.value.accountIdLabel}`;
    return;
  }

  isLoading.value = true;
  try {
    const result = await dashboardApi.accounts.create({ provider: provider.value, token: apiKey.value.trim(), cfAccountId: cfAccountId.value.trim() || undefined });
    if (!result.success) throw new Error(result.error);
    finishConnection(result.data);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Failed to connect account";
  } finally {
    isLoading.value = false;
  }
}

async function handleConnectCodexSession() {
  if (props.readonly) return;

  errorMessage.value = "";
  if (!chatgptSessionJson.value.trim()) {
    errorMessage.value = "Please paste the ChatGPT session";
    return;
  }

  isLoading.value = true;
  try {
    const result = await dashboardApi.accounts.connectCodexSession({ sessionJson: chatgptSessionJson.value.trim() });
    if (!result.success) throw new Error(result.error);
    finishConnection(result.data);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Failed to connect account";
  } finally {
    isLoading.value = false;
  }
}

async function handleExchangeOAuth() {
  if (props.readonly) return;
  if (!provider.value) return;

  errorMessage.value = "";
  if (!callbackUrl.value.trim()) {
    errorMessage.value = "Please paste the callback URL";
    return;
  }

  if (!callbackUrl.value.includes("code=")) {
    errorMessage.value = "Invalid URL. Make sure the URL contains 'code=' parameter.";
    return;
  }

  isLoading.value = true;
  try {
    const result = await dashboardApi.accounts.exchangeOAuth({ provider: provider.value as "antigravity" | "codex" | "kiro", callbackUrl: callbackUrl.value.trim(), state: oauthState.value, codeVerifier: oauthCodeVerifier.value });
    if (!result.success) throw new Error(result.error);
    finishConnection(result.data);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Failed to connect account";
  } finally {
    isLoading.value = false;
  }
}

function handleCallbackInput(event: Event) {
  clearCallbackAutoExchangeTimer();
  if (props.readonly || isLoading.value) return;
  const value = event.target instanceof HTMLInputElement ? event.target.value : callbackUrl.value;
  try {
    const url = new URL(value);
    if (!url.searchParams.get("code")) return;
  } catch {
    return;
  }

  callbackAutoExchangeTimer = setTimeout(() => {
    callbackAutoExchangeTimer = null;
    void handleExchangeOAuth();
  }, 300);
}

async function pasteCallbackUrl() {
  if (props.readonly || isLoading.value) return;

  try {
    const value = await navigator.clipboard.readText();
    callbackUrl.value = value.trim();
    copiedCallbackUrl.value = true;
    if (copiedCallbackUrlTimer) clearTimeout(copiedCallbackUrlTimer);
    copiedCallbackUrlTimer = setTimeout(() => {
      copiedCallbackUrl.value = false;
      copiedCallbackUrlTimer = null;
    }, 2000);
    clearCallbackAutoExchangeTimer();
    await handleExchangeOAuth();
  } catch {
    errorMessage.value = "Failed to paste callback URL";
  }
}

async function handleCallbackPaste(event: ClipboardEvent) {
  if (props.readonly || isLoading.value) return;

  const pastedText = event.clipboardData?.getData("text").trim();
  if (!pastedText) return;

  event.preventDefault();
  callbackUrl.value = pastedText;
  clearCallbackAutoExchangeTimer();
  await nextTick();
  await handleExchangeOAuth();
}

function goBack() {
  clearCopyAutoNextTimer();
  const nextStep = Math.max(minimumStep.value, step.value - 1);
  step.value = nextStep;

  if (step.value === 1) {
    provider.value = null;
    selectedMethod.value = null;
    return;
  }

  if (step.value === 2) {
    selectedMethod.value = null;
  }
}

function goBackFromDevicePolling() {
  clearCopyAutoNextTimer();
  resetAuthProgress();
  step.value = authStep.value;
}

onBeforeUnmount(() => {
  if (pollingTimer) {
    clearTimeout(pollingTimer);
    pollingTimer = null;
  }
  if (copiedLinkTimer) {
    clearTimeout(copiedLinkTimer);
    copiedLinkTimer = null;
  }
  if (copiedDeviceCodeTimer) {
    clearTimeout(copiedDeviceCodeTimer);
    copiedDeviceCodeTimer = null;
  }
  if (copiedCallbackUrlTimer) {
    clearTimeout(copiedCallbackUrlTimer);
    copiedCallbackUrlTimer = null;
  }
  clearCallbackAutoExchangeTimer();
  clearCopyAutoNextTimer();
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
    :ui="{ content: 'max-h-[calc(100dvh-1rem)] p-4 sm:max-w-md sm:p-6' }"
  >
    <template #content>
      <div class="space-y-1.5 pr-6">
        <h2 class="text-lg font-semibold leading-none tracking-tight">
          {{ selectedConfig ? `Add ${selectedConfig.name} Account` : 'Add Provider Account' }}
        </h2>
        <p class="sr-only">
          {{ selectedConfig ? `Connect a new ${selectedConfig.name} account for load balancing` : 'Connect a new AI provider account for load balancing' }}
        </p>
      </div>

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
              <span class="text-sm font-medium">{{ providerConfigs[providerKey].name }}</span>
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
              <span class="space-y-1">
                <span class="flex items-center gap-2 text-sm font-medium">
                  {{ method.name }}
                  <span v-if="method.tag" class="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{{ method.tag }}</span>
                  <span v-if="method.disabled" class="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">Unavailable</span>
                </span>
                <span class="block text-xs text-muted-foreground">{{ method.description }}</span>
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
  </UiDialog>
</template>
