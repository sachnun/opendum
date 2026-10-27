import {
  callbackPlaceholder,
  chatgptSessionPlaceholder,
  providerConfigs,
  providerOptions,
  isDevice,
  oauthCheck,
} from "@opendum/providers/auth/config";
import { errorText, parseUrl, raise, settle } from "~~/lib/settle";
import type { DeviceProviderKey } from "@opendum/providers/provider-accounts";
import type { FlowType, MethodKey, Provider, ProviderConfig } from "@opendum/providers/auth/config";

export function useAccountConnect(
  props: { initialProvider: Provider | null; triggerClass?: string; readonly?: boolean },
  handlers: {
    onConnected: (result: { provider: Provider; email: string; isUpdate: boolean }) => void;
    customCreated: (slug: string) => void;
  }
) {
const api = useApi();
const invalidation = useInvalidate();













const customProviders = useAsyncData(dataKeys.customProviders, () => api.customProviders.list());
const customList = computed(() => customProviders.data.value ?? []);
const customProviderConfigs = computed<Record<string, ProviderConfig>>(() => Object.fromEntries(
  customList.value.map((row) => [row.slug, {
    name: row.name,
    methods: [{ key: "api_key" as MethodKey, name: "API Key" }],
    apiKeyPlaceholder: "sk-...",
  } satisfies ProviderConfig]),
));

function customProvider(providerKey: string | null): boolean {
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
const apiKeyVisible = ref(false);
const isLoading = ref(false);
const isFetchingUrl = ref(false);
const isPolling = ref(false);
const errorMessage = ref("");
let pollingTimer: ReturnType<typeof setTimeout> | null = null;
let copiedLinkTimer: ReturnType<typeof setTimeout> | null = null;
let copiedCodeTimer: ReturnType<typeof setTimeout> | null = null;
let copiedCallbackTimer: ReturnType<typeof setTimeout> | null = null;
let copyTimer: ReturnType<typeof setTimeout> | null = null;
let exchangeTimer: ReturnType<typeof setTimeout> | null = null;

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
  return customProvider(provider.value) ? steps.filter((stepNumber) => stepNumber !== authStep.value) : steps;
});
const preventOutsideClose = computed(() => {
  const flowType = activeFlowType.value;
  return customMode.value || isPolling.value || (step.value === authStep.value && (flowType === "api_key" || flowType === "api_key_with_account_id" || flowType === "chatgpt_session")) || (step.value === finishStep.value && flowType === "oauth_redirect");
});

function customCreated(createdSlug: string) {
  customMode.value = false;
  open.value = false;
  handlers.customCreated(createdSlug);
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

  const started = await settle(async () => {
    if (selectedFlowType === "oauth_redirect") {
      if (!oauthCheck(selectedProvider)) return;
      const result = await api.accounts.getAuthUrl({ provider: selectedProvider });
      if (!result.success) return raise(new Error(result.error));
      if (provider.value !== selectedProvider || activeFlowType.value !== selectedFlowType || step.value !== selectedStep) return;
      authUrl.value = result.data.authUrl;
      oauthState.value = result.data.state;
      oauthCodeVerifier.value = result.data.codeVerifier;
      return;
    }

    if (selectedFlowType === "device_code") {
      if (!isDevice(selectedProvider)) return;
      const result = await api.accounts.initiateDeviceAuth({ provider: selectedProvider });
      if (!result.success) return raise(new Error(result.error));
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
  });
  if (provider.value === selectedProvider && activeFlowType.value === selectedFlowType && step.value === selectedStep) {
    isFetchingUrl.value = false;
  }
  if (!started.ok) errorMessage.value = errorText(started.error, "Failed to start account connection");
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
  apiKeyVisible.value = false;
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
  if (copiedCodeTimer) {
    clearTimeout(copiedCodeTimer);
    copiedCodeTimer = null;
  }
  if (copiedCallbackTimer) {
    clearTimeout(copiedCallbackTimer);
    copiedCallbackTimer = null;
  }
  if (copyTimer) {
    clearTimeout(copyTimer);
    copyTimer = null;
  }
  clearExchange();
}

function clearCopy() {
  if (!copyTimer) return;
  clearTimeout(copyTimer);
  copyTimer = null;
}

function clearExchange() {
  if (!exchangeTimer) return;
  clearTimeout(exchangeTimer);
  exchangeTimer = null;
}

function finishConnection(result: { email: string; isUpdate: boolean }) {
  const connectedProvider = provider.value;
  if (!connectedProvider) return;

  open.value = false;
  handlers.onConnected({ provider: connectedProvider, ...result });
  void invalidation.invalidateAccountCollection(connectedProvider);
  if (customProvider(connectedProvider)) void invalidation.refreshData(dataKeys.customProviders);
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

function resetProgress() {
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

function selectLogin(method: MethodKey) {
  if (props.readonly) return;
  const config = selectedConfig.value;
  const target = config?.methods.find((item) => item.key === method && !item.disabled);
  if (!config || !target) return;
  resetProgress();
  selectedMethod.value = method;
  const flow = target.flow ?? (method as FlowType);
  step.value = flow === "api_key" && !config.apiKeyPortalUrl ? finishStep.value : authStep.value;
}



async function copyText(value: string, target: "link" | "code") {
  const copied = await settle(() => navigator.clipboard.writeText(value));
  if (!copied.ok) {
    errorMessage.value = target === "link" ? "Failed to copy link" : "Failed to copy code";
    return;
  }
  {
    if (target === "link") {
      copiedLink.value = true;
      if (copiedLinkTimer) clearTimeout(copiedLinkTimer);
      copiedLinkTimer = setTimeout(() => {
        copiedLink.value = false;
        copiedLinkTimer = null;
      }, 2000);
    } else {
      copiedDeviceCode.value = true;
      if (copiedCodeTimer) clearTimeout(copiedCodeTimer);
      copiedCodeTimer = setTimeout(() => {
        copiedDeviceCode.value = false;
        copiedCodeTimer = null;
      }, 2000);
    }
  }

  if (target === "link" && activeFlowType.value !== "device_code" && step.value === authStep.value) {
    clearCopy();
    copyTimer = setTimeout(() => {
      if (step.value === authStep.value && activeFlowType.value !== "device_code") {
        step.value = finishStep.value;
      }
      copyTimer = null;
    }, 2000);
  }

  if (target === "link" && activeFlowType.value === "device_code") {
    startPolling(null);
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

function oauthUrl() {
  if (!authUrl.value) return;
  openPopup(authUrl.value, "oauth_popup", 600, 700);
  setTimeout(() => (step.value = finishStep.value), 600);
}

function deviceUrl() {
  if (!deviceCodeInfo.value) return;
  const popup = openPopup(deviceCodeInfo.value.verificationUrl, "device_auth_popup", 600, 700);
  startPolling(popup);
}

function keyPortal() {
  if (!selectedConfig.value?.apiKeyPortalUrl) return;
  openPopup(selectedConfig.value.apiKeyPortalUrl, "api_key_portal_popup", 1100, 760);
  if (step.value === authStep.value) setTimeout(() => (step.value = finishStep.value), 600);
}

function startPolling(popup: Window | null) {
  if (!deviceCodeInfo.value || isPolling.value) return;

  isPolling.value = true;
  errorMessage.value = "";
  const startedAt = Date.now();
  let intervalMs = 8000;

  const stopPolling = (returnToAuth = false) => {
    stopPolling();
    if (returnToAuth && step.value === finishStep.value && finishStep.value > authStep.value) {
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

    {
      const info = deviceCodeInfo.value;
      if (!info) return;
      const polled = await settle(() =>
        api.accounts.pollAuth({
          provider: info.provider,
          deviceCode: info.deviceCode,
          userCode: info.userCode,
          codeVerifier: info.codeVerifier,
          method: info.method,
          machineId: info.machineId,
        })
      );
      if (!polled.ok) {
        errorMessage.value = errorText(polled.error, "Failed to check authorization status");
        pollingTimer = setTimeout(poll, intervalMs);
        return;
      }
      const result = polled.value;
      if (!result.success) {
        errorMessage.value = result.error;
        pollingTimer = setTimeout(poll, intervalMs);
        return;
      }
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
    }

    pollingTimer = setTimeout(poll, intervalMs);
  };

  pollingTimer = setTimeout(poll, intervalMs);
}

async function connectKey() {
  if (props.readonly) return;
  if (!provider.value || !selectedConfig.value) return;

  errorMessage.value = "";
  if (!apiKey.value.trim()) {
    errorMessage.value = activeFlowType.value === "api_key_with_account_id" ? "Please enter an API token" : "Please enter an API key";
    return;
  }
  const activeProvider = provider.value;
  if (customProvider(activeProvider)) {
    isLoading.value = true;
    const connected = await settle(() =>
      api.customProviders.connect({ slug: activeProvider, token: apiKey.value.trim() })
    );
    isLoading.value = false;
    if (!connected.ok) {
      errorMessage.value = errorText(connected.error, "Failed to connect account");
      return;
    }
    if (!connected.value.success) {
      errorMessage.value = connected.value.error;
      return;
    }
    finishConnection({ email: `custom-${activeProvider}`, isUpdate: connected.value.data.isUpdate });
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
  const connectProvider = provider.value;
  if (!connectProvider) return;
  const connected = await settle(() =>
    api.accounts.create({
      provider: connectProvider,
      token: apiKey.value.trim(),
      cfAccountId: cfAccountId.value.trim() || undefined,
      platformKey: platformKey.value.trim() || undefined,
    })
  );
  isLoading.value = false;
  if (!connected.ok) {
    errorMessage.value = errorText(connected.error, "Failed to connect account");
    return;
  }
  if (!connected.value.success) {
    errorMessage.value = connected.value.error;
    return;
  }
  finishConnection(connected.value.data);
}

async function connectCodex() {
  if (props.readonly) return;

  errorMessage.value = "";
  if (!chatgptSessionJson.value.trim()) {
    errorMessage.value = "Please paste the ChatGPT session";
    return;
  }

  isLoading.value = true;
  const connected = await settle(() => api.accounts.connectCodexSession({ sessionJson: chatgptSessionJson.value.trim() }));
  isLoading.value = false;
  if (!connected.ok) {
    errorMessage.value = errorText(connected.error, "Failed to connect account");
    return;
  }
  if (!connected.value.success) {
    errorMessage.value = connected.value.error;
    return;
  }
  finishConnection(connected.value.data);
}

async function oauthExchange() {
  if (props.readonly) return;
  const selectedProvider = provider.value;
  if (!selectedProvider) return;
  if (!oauthCheck(selectedProvider)) return;

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
  const connected = await settle(() => api.accounts.oauthExchange({ provider: selectedProvider, callbackUrl: callbackUrl.value.trim(), state: oauthState.value, codeVerifier: oauthCodeVerifier.value }));
  isLoading.value = false;
  if (!connected.ok) {
    errorMessage.value = errorText(connected.error, "Failed to connect account");
    return;
  }
  if (!connected.value.success) {
    errorMessage.value = connected.value.error;
    return;
  }
  finishConnection(connected.value.data);
}

function callbackInput(event: Event) {
  clearExchange();
  if (props.readonly || isLoading.value) return;
  const value = event.target instanceof HTMLInputElement ? event.target.value : callbackUrl.value;
  const parsed = parseUrl(value);
  if (!parsed || !parsed.searchParams.get("code")) return;

  exchangeTimer = setTimeout(() => {
    exchangeTimer = null;
    void oauthExchange();
  }, 300);
}

async function pasteCallback() {
  if (props.readonly || isLoading.value) return;

  const pasted = await settle(() => navigator.clipboard.readText());
  if (!pasted.ok) {
    errorMessage.value = "Failed to paste callback URL";
    return;
  }
  callbackUrl.value = pasted.value.trim();
  copiedCallbackUrl.value = true;
  if (copiedCallbackTimer) clearTimeout(copiedCallbackTimer);
  copiedCallbackTimer = setTimeout(() => {
    copiedCallbackUrl.value = false;
    copiedCallbackTimer = null;
  }, 2000);
  clearExchange();
  await oauthExchange();
}

async function callbackPaste(event: ClipboardEvent) {
  if (props.readonly || isLoading.value) return;

  const pastedText = event.clipboardData?.getData("text").trim();
  if (!pastedText) return;

  event.preventDefault();
  callbackUrl.value = pastedText;
  clearExchange();
  await nextTick();
  await oauthExchange();
}

function goBack() {
  clearCopy();
  const previousStep = step.value;
  let nextStep = Math.max(minimumStep.value, step.value - 1);
  if (nextStep === authStep.value && previousStep === finishStep.value && customProvider(provider.value)) {
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

function backPolling() {
  clearCopy();
  resetProgress();
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
  if (copiedCodeTimer) {
    clearTimeout(copiedCodeTimer);
    copiedCodeTimer = null;
  }
  if (copiedCallbackTimer) {
    clearTimeout(copiedCallbackTimer);
    copiedCallbackTimer = null;
  }
  clearExchange();
  clearCopy();
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
    apiKeyVisible,
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
    preventOutsideClose,
    customCreated,
    selectProvider,
    selectCustom,
    selectLogin,
    copyText,
    openPopup,
    oauthUrl,
    deviceUrl,
    keyPortal,
    connectKey,
    connectCodex,
    callbackInput,
    pasteCallback,
    callbackPaste,
    goBack,
    backPolling,
    providerOptions,
    chatgptSessionPlaceholder,
    providerConfigs,
    callbackPlaceholder,
  };
}
