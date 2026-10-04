import {
  callbackPlaceholder,
  chatgptSessionPlaceholder,
  providerConfigs,
  providerOptions,
  isDeviceProvider,
  isOAuthProvider,
} from "~~/lib/provider-auth-config";
import type { DeviceProviderKey } from "~~/lib/provider-accounts";
import type { FlowType, MethodKey, Provider, ProviderConfig } from "~~/lib/provider-auth-config";

export function useAccountConnect(
  props: { initialProvider: Provider | null; triggerClass?: string; readonly?: boolean },
  handlers: {
    onConnected: (result: { provider: Provider; email: string; isUpdate: boolean }) => void;
    onCustomCreated: (slug: string) => void;
  }
) {
const api = useApi();
const invalidation = useInvalidate();













const customProviders = useCachedData(dataKeys.customProviders, () => api.customProviders.list());
const customList = computed(() => customProviders.data.value ?? []);
const customProviderConfigs = computed<Record<string, ProviderConfig>>(() => Object.fromEntries(
  customList.value.map((row) => [row.slug, {
    name: row.name,
    methods: [{ key: "api_key" as MethodKey, name: "API Key" }],
    apiKeyPlaceholder: "sk-...",
  } satisfies ProviderConfig]),
));

function isCustomProvider(providerKey: string | null): boolean {
  return providerKey !== null && customList.value.some((row) => row.slug === providerKey);
}

const open = ref(false);
const customMode = ref(false);
const minimumStep = computed(() => (props.initialProvider ? 2 : 1));
const step = ref(minimumStep.value);
const provider = ref<Provider | null>(props.initialProvider);
const callbackUrl = ref("");
const chatgptSessionJson = ref("");
const apiKey = ref("");
const platformKey = ref("");
const cfAccountId = ref("");
const authUrl = ref("");
const oauthState = ref<string | null>(null);
const oauthCodeVerifier = ref<string | null>(null);
const selectedMethod = ref<MethodKey | null>(null);
const deviceCodeInfo = ref<{ provider: DeviceProviderKey; deviceCode: string; userCode: string; verificationUrl: string; codeVerifier?: string; method?: string; machineId?: string } | null>(null);
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

const selectedConfig = computed<ProviderConfig | null>(() => {
  const key = provider.value;
  if (!key) return null;
  return (providerConfigs as Record<string, ProviderConfig | undefined>)[key] ?? customProviderConfigs.value[key] ?? null;
});
const activeFlowType = computed<FlowType | null>(() => {
  if (!selectedConfig.value || !selectedMethod.value) return null;
  const method = selectedConfig.value.methods.find((item) => item.key === selectedMethod.value && !item.disabled);
  if (!method) return null;
  return method.flow ?? (method.key as FlowType);
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
  const steps = props.initialProvider ? [2, 3, 4] : [1, 2, 3, 4];
  return isCustomProvider(provider.value) ? steps.filter((stepNumber) => stepNumber !== authStep.value) : steps;
});
const shouldPreventOutsideClose = computed(() => {
  const flowType = activeFlowType.value;
  return customMode.value || isPolling.value || (step.value === authStep.value && (flowType === "api_key" || flowType === "api_key_with_account_id" || flowType === "chatgpt_session")) || (step.value === finishStep.value && flowType === "oauth_redirect");
});

function handleCustomCreated(createdSlug: string) {
  customMode.value = false;
  open.value = false;
  handlers.onCustomCreated(createdSlug);
  void invalidation.refreshData(dataKeys.customProviders);
  void invalidation.invalidateAccountCollection(createdSlug);
}

watch(open, (value) => {
  if (value) {
    step.value = minimumStep.value;
    provider.value = props.initialProvider;
    selectedMethod.value = null;
    customMode.value = false;
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
      if (!isOAuthProvider(selectedProvider)) return;
      const result = await api.accounts.getAuthUrl({ provider: selectedProvider });
      if (!result.success) throw new Error(result.error);
      if (provider.value !== selectedProvider || activeFlowType.value !== selectedFlowType || step.value !== selectedStep) return;
      authUrl.value = result.data.authUrl;
      oauthState.value = result.data.state;
      oauthCodeVerifier.value = result.data.codeVerifier;
      return;
    }

    if (selectedFlowType === "device_code") {
      if (!isDeviceProvider(selectedProvider)) return;
      const result = await api.accounts.initiateDeviceAuth({ provider: selectedProvider });
      if (!result.success) throw new Error(result.error);
      if (provider.value !== selectedProvider || activeFlowType.value !== selectedFlowType || step.value !== selectedStep) return;
      deviceCodeInfo.value = {
        provider: selectedProvider,
        deviceCode: result.data.deviceCode,
        userCode: result.data.userCode,
        verificationUrl: result.data.verificationUrlComplete || result.data.verificationUrl,
        codeVerifier: "codeVerifier" in result.data && typeof result.data.codeVerifier === "string" ? result.data.codeVerifier : undefined,
        machineId: "machineId" in result.data && typeof result.data.machineId === "string" ? result.data.machineId : undefined,
      };
      return;
    }

    authUrl.value = selectedConfig.value?.apiKeyPortalUrl ?? "";
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
  customMode.value = false;
  provider.value = props.initialProvider;
  callbackUrl.value = "";
  chatgptSessionJson.value = "";
  apiKey.value = "";
  platformKey.value = "";
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
  handlers.onConnected({ provider: connectedProvider, ...result });
  void invalidation.invalidateAccountCollection(connectedProvider);
  if (isCustomProvider(connectedProvider)) void invalidation.refreshData(dataKeys.customProviders);
}

function selectProvider(providerKey: Provider) {
  if (props.readonly) return;
  provider.value = providerKey;
  selectedMethod.value = null;
  step.value = 2;
}

function selectCustom() {
  if (props.readonly) return;
  provider.value = null;
  selectedMethod.value = null;
  customMode.value = true;
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
  const config = selectedConfig.value;
  const target = config?.methods.find((item) => item.key === method && !item.disabled);
  if (!config || !target) return;
  resetAuthProgress();
  selectedMethod.value = method;
  const flow = target.flow ?? (method as FlowType);
  step.value = flow === "api_key" && !config.apiKeyPortalUrl ? finishStep.value : authStep.value;
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
      const result = await api.accounts.pollDeviceAuth({
        provider: deviceCodeInfo.value.provider,
        deviceCode: deviceCodeInfo.value.deviceCode,
        userCode: deviceCodeInfo.value.userCode,
        codeVerifier: deviceCodeInfo.value.codeVerifier,
        method: deviceCodeInfo.value.method,
        machineId: deviceCodeInfo.value.machineId,
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
  const activeProvider = provider.value;
  if (isCustomProvider(activeProvider)) {
    isLoading.value = true;
    try {
      const result = await api.customProviders.connect({ slug: activeProvider, token: apiKey.value.trim() });
      if (!result.success) throw new Error(result.error);
      finishConnection({ email: `custom-${activeProvider}`, isUpdate: result.data.isUpdate });
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : "Failed to connect account";
    } finally {
      isLoading.value = false;
    }
    return;
  }
  if (provider.value === "zenmux" && !platformKey.value.trim()) {
    errorMessage.value = "Please enter a Platform Key. Get it from ZenMux → Management → API Keys.";
    return;
  }

  if (activeFlowType.value === "api_key_with_account_id" && !cfAccountId.value.trim()) {
    errorMessage.value = `Please enter the ${selectedConfig.value.accountIdLabel}`;
    return;
  }

  isLoading.value = true;
  try {
    const result = await api.accounts.create({ provider: provider.value, token: apiKey.value.trim(), cfAccountId: cfAccountId.value.trim() || undefined, platformKey: platformKey.value.trim() || undefined });
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
    const result = await api.accounts.connectCodexSession({ sessionJson: chatgptSessionJson.value.trim() });
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
  const selectedProvider = provider.value;
  if (!selectedProvider) return;
  if (!isOAuthProvider(selectedProvider)) return;

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
    const result = await api.accounts.exchangeOAuth({ provider: selectedProvider, callbackUrl: callbackUrl.value.trim(), state: oauthState.value, codeVerifier: oauthCodeVerifier.value });
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
  const previousStep = step.value;
  let nextStep = Math.max(minimumStep.value, step.value - 1);
  if (nextStep === authStep.value && previousStep === finishStep.value && isCustomProvider(provider.value)) {
    nextStep = Math.max(minimumStep.value, authStep.value - 1);
  }
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

  return {
    api,
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
  };
}
