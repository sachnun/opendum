import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js";
import {
  callbackPlaceholder,
  chatgptSessionPlaceholder,
  providerConfigs,
  providerOptions,
  isDevice,
  oauthCheck,
  type FlowType,
  type MethodKey,
  type Provider,
  type ProviderConfig,
} from "@opendum/providers/auth/config";
import type { DeviceProviderKey } from "@opendum/providers/provider-accounts";
import { api } from "~/api";
import { errorText, parseUrl, raise, settle } from "~/lib/settle";
import { invalidation } from "~/lib/invalidate";
import { dataKeys } from "~/lib/data-keys";
import { createQuery } from "~/lib/query";

export interface AccountConnectHandlers {
  onConnected: (result: { provider: Provider; email: string; isUpdate: boolean }) => void;
  customCreated: (slug: string) => void;
}

export function createAccountConnect(
  initialProvider: Accessor<Provider | null>,
  readonly: Accessor<boolean>,
  handlers: AccountConnectHandlers
) {
  const customProviders = createQuery(dataKeys.customProviders, () => api.customProviders.list(), { defaultValue: [] });
  const customList = () => customProviders.data() ?? [];
  const customProviderConfigs = createMemo<Record<string, ProviderConfig>>(() =>
    Object.fromEntries(
      customList().map((row) => [
        row.slug,
        {
          name: row.name,
          methods: [{ key: "api_key" as MethodKey, name: "API Key" }],
          apiKeyPlaceholder: "sk-...",
        } satisfies ProviderConfig,
      ])
    )
  );

  function isCustomProvider(providerKey: string | null): boolean {
    return providerKey !== null && customList().some((row) => row.slug === providerKey);
  }

  const [open, setOpen] = createSignal(false);
  const [customMode, setCustomMode] = createSignal(false);
  const minimumStep = createMemo(() => (initialProvider() ? 2 : 1));
  const [step, setStep] = createSignal(minimumStep());
  const [provider, setProvider] = createSignal<Provider | null>(initialProvider());
  const [callbackUrl, setCallbackUrl] = createSignal("");
  const [chatgptSessionJson, setChatgptSessionJson] = createSignal("");
  const [apiKey, setApiKey] = createSignal("");
  const [platformKey, setPlatformKey] = createSignal("");
  const [cfAccountId, setCfAccountId] = createSignal("");
  const [authUrl, setAuthUrl] = createSignal("");
  const [oauthState, setOauthState] = createSignal<string | null>(null);
  const [oauthCodeVerifier, setOauthCodeVerifier] = createSignal<string | null>(null);
  const [selectedMethod, setSelectedMethod] = createSignal<MethodKey | null>(null);
  const [deviceCodeInfo, setDeviceCodeInfo] = createSignal<{
    provider: DeviceProviderKey;
    deviceCode: string;
    userCode: string;
    verificationUrl: string;
    codeVerifier?: string;
    method?: string;
    machineId?: string;
  } | null>(null);
  const [copiedLink, setCopiedLink] = createSignal(false);
  const [copiedDeviceCode, setCopiedDeviceCode] = createSignal(false);
  const [copiedCallbackUrl, setCopiedCallbackUrl] = createSignal(false);
  const [apiKeyVisible, setApiKeyVisible] = createSignal(false);
  const [isLoading, setIsLoading] = createSignal(false);
  const [isFetchingUrl, setIsFetchingUrl] = createSignal(false);
  const [isPolling, setIsPolling] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal("");

  let pollingTimer: ReturnType<typeof setTimeout> | null = null;
  let copiedLinkTimer: ReturnType<typeof setTimeout> | null = null;
  let copiedCodeTimer: ReturnType<typeof setTimeout> | null = null;
  let copiedCallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let copyTimer: ReturnType<typeof setTimeout> | null = null;
  let exchangeTimer: ReturnType<typeof setTimeout> | null = null;

  const selectedConfig = createMemo<ProviderConfig | null>(() => {
    const key = provider();
    if (!key) return null;
    return (providerConfigs as Record<string, ProviderConfig | undefined>)[key] ?? customProviderConfigs()[key] ?? null;
  });

  const activeFlowType = createMemo<FlowType | null>(() => {
    const config = selectedConfig();
    const method = selectedMethod();
    if (!config || !method) return null;
    const entry = config.methods.find((item) => item.key === method && !item.disabled);
    if (!entry) return null;
    return entry.flow ?? (entry.key as FlowType);
  });

  const authStep = createMemo(() => 3);
  const finishStep = createMemo(() => 4);

  function setDialogOpen(value: boolean) {
    if (!value && isLoading()) return;
    setOpen(value);
  }

  const displayedSteps = createMemo(() => {
    const steps = initialProvider() ? [2, 3, 4] : [1, 2, 3, 4];
    return isCustomProvider(provider()) ? steps.filter((stepNumber) => stepNumber !== authStep()) : steps;
  });

  const preventOutsideClose = createMemo(() => {
    const flowType = activeFlowType();
    return (
      customMode() ||
      isPolling() ||
      (step() === authStep() && (flowType === "api_key" || flowType === "api_key_with_account_id" || flowType === "chatgpt_session")) ||
      (step() === finishStep() && flowType === "oauth_redirect")
    );
  });

  function handleCustomCreated(createdSlug: string) {
    setCustomMode(false);
    setOpen(false);
    handlers.customCreated(createdSlug);
    void invalidation.refreshData(dataKeys.customProviders);
    void invalidation.invalidateAccountCollection(createdSlug);
  }

  createEffect(
    on(open, (value) => {
      if (value) {
        setStep(minimumStep());
        setProvider(initialProvider());
        setSelectedMethod(null);
        setCustomMode(false);
        return;
      }

      resetForm();
    })
  );

  createEffect(
    on([open, step, provider, selectedMethod], async () => {
      if (readonly()) return;
      const config = selectedConfig();
      const flowType = activeFlowType();
      const selectedProvider = provider();
      const selectedStep = step();
      if (!open() || selectedStep !== authStep() || !selectedProvider || !config || !flowType) return;

      setErrorMessage("");
      setAuthUrl("");
      setOauthState(null);
      setOauthCodeVerifier(null);
      setDeviceCodeInfo(null);
      setIsFetchingUrl(true);

      const started = await settle(async () => {
        if (flowType === "oauth_redirect") {
          if (!oauthCheck(selectedProvider)) return;
          const result = await api.accounts.getAuthUrl({ provider: selectedProvider });
          if (!result.success) return raise(new Error(result.error));
          if (provider() !== selectedProvider || activeFlowType() !== flowType || step() !== selectedStep) return;
          setAuthUrl(result.data.authUrl);
          setOauthState(result.data.state);
          setOauthCodeVerifier(result.data.codeVerifier);
          return;
        }

        if (flowType === "device_code") {
          if (!isDevice(selectedProvider)) return;
          const result = await api.accounts.initiateDeviceAuth({ provider: selectedProvider });
          if (!result.success) return raise(new Error(result.error));
          if (provider() !== selectedProvider || activeFlowType() !== flowType || step() !== selectedStep) return;
          setDeviceCodeInfo({
            provider: selectedProvider,
            deviceCode: result.data.deviceCode,
            userCode: result.data.userCode,
            verificationUrl: result.data.verificationUrlComplete || result.data.verificationUrl,
            codeVerifier:
              "codeVerifier" in result.data && typeof result.data.codeVerifier === "string" ? result.data.codeVerifier : undefined,
            machineId: "machineId" in result.data && typeof result.data.machineId === "string" ? result.data.machineId : undefined,
          });
          return;
        }

        setAuthUrl(config.apiKeyPortalUrl ?? "");
      });
      if (provider() === selectedProvider && activeFlowType() === flowType && step() === selectedStep) {
        setIsFetchingUrl(false);
      }
      if (!started.ok) setErrorMessage(errorText(started.error, "Failed to start account connection"));
    })
  );

  function clearTimer(timer: ReturnType<typeof setTimeout> | null): null {
    if (timer) clearTimeout(timer);
    return null;
  }

  function resetForm() {
    setStep(minimumStep());
    setCustomMode(false);
    setProvider(initialProvider());
    setCallbackUrl("");
    setChatgptSessionJson("");
    setApiKey("");
    setPlatformKey("");
    setCfAccountId("");
    setAuthUrl("");
    setOauthState(null);
    setOauthCodeVerifier(null);
    setSelectedMethod(null);
    setDeviceCodeInfo(null);
    setCopiedLink(false);
    setCopiedDeviceCode(false);
    setCopiedCallbackUrl(false);
    setApiKeyVisible(false);
    setIsLoading(false);
    setIsFetchingUrl(false);
    setIsPolling(false);
    setErrorMessage("");
    pollingTimer = clearTimer(pollingTimer);
    copiedLinkTimer = clearTimer(copiedLinkTimer);
    copiedCodeTimer = clearTimer(copiedCodeTimer);
    copiedCallbackTimer = clearTimer(copiedCallbackTimer);
    copyTimer = clearTimer(copyTimer);
    exchangeTimer = clearTimer(exchangeTimer);
  }

  function finishConnection(result: { email: string; isUpdate: boolean }) {
    const connectedProvider = provider();
    if (!connectedProvider) return;

    setOpen(false);
    handlers.onConnected({ provider: connectedProvider, ...result });
    void invalidation.invalidateAccountCollection(connectedProvider);
    if (isCustomProvider(connectedProvider)) void invalidation.refreshData(dataKeys.customProviders);
  }

  function selectProvider(providerKey: Provider) {
    if (readonly()) return;
    setProvider(providerKey);
    setSelectedMethod(null);
    setStep(2);
  }

  function selectCustom() {
    if (readonly()) return;
    setProvider(null);
    setSelectedMethod(null);
    setCustomMode(true);
  }

  function resetProgress() {
    setCallbackUrl("");
    setChatgptSessionJson("");
    setAuthUrl("");
    setOauthState(null);
    setOauthCodeVerifier(null);
    setDeviceCodeInfo(null);
    setCopiedLink(false);
    setCopiedDeviceCode(false);
    setCopiedCallbackUrl(false);
    setIsFetchingUrl(false);
    setIsPolling(false);
    setErrorMessage("");
    pollingTimer = clearTimer(pollingTimer);
  }

  function selectLogin(method: MethodKey) {
    if (readonly()) return;
    const config = selectedConfig();
    const target = config?.methods.find((item) => item.key === method && !item.disabled);
    if (!config || !target) return;
    resetProgress();
    setSelectedMethod(method);
    const flow = target.flow ?? (method as FlowType);
    setStep(flow === "api_key" && !config.apiKeyPortalUrl ? finishStep() : authStep());
  }

  async function copyText(value: string, target: "link" | "code") {
    const copied = await settle(() => navigator.clipboard.writeText(value));
    if (!copied.ok) {
      setErrorMessage(target === "link" ? "Failed to copy link" : "Failed to copy code");
      return;
    }

    if (target === "link") {
      setCopiedLink(true);
      copiedLinkTimer = clearTimer(copiedLinkTimer);
      copiedLinkTimer = setTimeout(() => {
        setCopiedLink(false);
        copiedLinkTimer = null;
      }, 2000);
    } else {
      setCopiedDeviceCode(true);
      copiedCodeTimer = clearTimer(copiedCodeTimer);
      copiedCodeTimer = setTimeout(() => {
        setCopiedDeviceCode(false);
        copiedCodeTimer = null;
      }, 2000);
    }

    if (target === "link" && activeFlowType() !== "device_code" && step() === authStep()) {
      copyTimer = clearTimer(copyTimer);
      copyTimer = setTimeout(() => {
        if (step() === authStep() && activeFlowType() !== "device_code") {
          setStep(finishStep());
        }
        copyTimer = null;
      }, 2000);
    }

    if (target === "link" && activeFlowType() === "device_code") {
      startPolling(null);
    }
  }

  function openPopup(url: string, name: string, width: number, height: number): Window | null {
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
    if (!authUrl()) return;
    openPopup(authUrl(), "oauth_popup", 600, 700);
    setTimeout(() => setStep(finishStep()), 600);
  }

  function deviceUrl() {
    const info = deviceCodeInfo();
    if (!info) return;
    const popup = openPopup(info.verificationUrl, "device_auth_popup", 600, 700);
    startPolling(popup);
  }

  function keyPortal() {
    const portalUrl = selectedConfig()?.apiKeyPortalUrl;
    if (!portalUrl) return;
    openPopup(portalUrl, "api_key_portal_popup", 1100, 760);
    if (step() === authStep()) setTimeout(() => setStep(finishStep()), 600);
  }

  function stopPolling(returnToAuth = false) {
    pollingTimer = clearTimer(pollingTimer);
    setIsPolling(false);
    if (returnToAuth && step() === finishStep() && finishStep() > authStep()) {
      setStep(authStep());
    }
  }

  function startPolling(popup: Window | null) {
    if (!deviceCodeInfo() || isPolling()) return;

    setIsPolling(true);
    setErrorMessage("");
    const startedAt = Date.now();
    let intervalMs = 8000;

    if (step() === authStep() && finishStep() > authStep()) {
      setStep(finishStep());
    }

    const poll = async () => {
      const info = deviceCodeInfo();
      if (!info) return;

      if (Date.now() - startedAt >= 900_000) {
        setErrorMessage("Device code expired. Please try again.");
        stopPolling(true);
        return;
      }

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
        setErrorMessage(errorText(polled.error, "Failed to check authorization status"));
        pollingTimer = setTimeout(poll, intervalMs);
        return;
      }
      const result = polled.value;
      if (!result.success) {
        setErrorMessage(result.error);
        pollingTimer = setTimeout(poll, intervalMs);
        return;
      }
      if (result.data.status === "success") {
        if (popup && !popup.closed) popup.close();
        finishConnection({ email: result.data.email, isUpdate: result.data.isUpdate });
        return;
      }

      if (result.data.status === "error") {
        setErrorMessage(result.data.message);
        stopPolling(true);
        return;
      }

      if (typeof result.data.retryAfterSeconds === "number" && result.data.retryAfterSeconds > 0) {
        intervalMs = result.data.retryAfterSeconds * 1000;
      }

      pollingTimer = setTimeout(poll, intervalMs);
    };

    pollingTimer = setTimeout(poll, intervalMs);
  }

  async function connectKey() {
    if (readonly()) return;
    const config = selectedConfig();
    const activeProvider = provider();
    if (!activeProvider || !config) return;

    setErrorMessage("");
    if (!apiKey().trim()) {
      setErrorMessage(activeFlowType() === "api_key_with_account_id" ? "Please enter an API token" : "Please enter an API key");
      return;
    }

    if (isCustomProvider(activeProvider)) {
      setIsLoading(true);
      const connected = await settle(() => api.customProviders.connect({ slug: activeProvider, token: apiKey().trim() }));
      setIsLoading(false);
      if (!connected.ok) {
        setErrorMessage(errorText(connected.error, "Failed to connect account"));
        return;
      }
      if (!connected.value.success) {
        setErrorMessage(connected.value.error);
        return;
      }
      finishConnection({ email: `custom-${activeProvider}`, isUpdate: connected.value.data.isUpdate });
      return;
    }
    if (activeProvider === "zenmux" && !platformKey().trim()) {
      setErrorMessage("Please enter a Platform Key. Get it from ZenMux → Management → API Keys.");
      return;
    }

    if (activeFlowType() === "api_key_with_account_id" && !cfAccountId().trim()) {
      setErrorMessage(`Please enter the ${config.accountIdLabel}`);
      return;
    }

    setIsLoading(true);
    const connected = await settle(() =>
      api.accounts.create({
        provider: activeProvider,
        token: apiKey().trim(),
        cfAccountId: cfAccountId().trim() || undefined,
        platformKey: platformKey().trim() || undefined,
      })
    );
    setIsLoading(false);
    if (!connected.ok) {
      setErrorMessage(errorText(connected.error, "Failed to connect account"));
      return;
    }
    if (!connected.value.success) {
      setErrorMessage(connected.value.error);
      return;
    }
    finishConnection(connected.value.data);
  }

  async function connectCodex() {
    if (readonly()) return;

    setErrorMessage("");
    if (!chatgptSessionJson().trim()) {
      setErrorMessage("Please paste the ChatGPT session");
      return;
    }

    setIsLoading(true);
    const connected = await settle(() => api.accounts.connectCodexSession({ sessionJson: chatgptSessionJson().trim() }));
    setIsLoading(false);
    if (!connected.ok) {
      setErrorMessage(errorText(connected.error, "Failed to connect account"));
      return;
    }
    if (!connected.value.success) {
      setErrorMessage(connected.value.error);
      return;
    }
    finishConnection(connected.value.data);
  }

  async function oauthExchange() {
    if (readonly()) return;
    const selectedProvider = provider();
    if (!selectedProvider) return;
    if (!oauthCheck(selectedProvider)) return;

    setErrorMessage("");
    if (!callbackUrl().trim()) {
      setErrorMessage("Please paste the callback URL");
      return;
    }

    if (!callbackUrl().includes("code=")) {
      setErrorMessage("Invalid URL. Make sure the URL contains 'code=' parameter.");
      return;
    }

    setIsLoading(true);
    const connected = await settle(() =>
      api.accounts.oauthExchange({
        provider: selectedProvider,
        callbackUrl: callbackUrl().trim(),
        state: oauthState(),
        codeVerifier: oauthCodeVerifier(),
      })
    );
    setIsLoading(false);
    if (!connected.ok) {
      setErrorMessage(errorText(connected.error, "Failed to connect account"));
      return;
    }
    if (!connected.value.success) {
      setErrorMessage(connected.value.error);
      return;
    }
    finishConnection(connected.value.data);
  }

  function callbackInput(event: Event) {
    exchangeTimer = clearTimer(exchangeTimer);
    if (readonly() || isLoading()) return;
    const value = event.target instanceof HTMLInputElement ? event.target.value : callbackUrl();
    const parsed = parseUrl(value);
    if (!parsed || !parsed.searchParams.get("code")) return;

    exchangeTimer = setTimeout(() => {
      exchangeTimer = null;
      void oauthExchange();
    }, 300);
  }

  async function pasteCallback() {
    if (readonly() || isLoading()) return;

    const pasted = await settle(() => navigator.clipboard.readText());
    if (!pasted.ok) {
      setErrorMessage("Failed to paste callback URL");
      return;
    }
    setCallbackUrl(pasted.value.trim());
    setCopiedCallbackUrl(true);
    copiedCallbackTimer = clearTimer(copiedCallbackTimer);
    copiedCallbackTimer = setTimeout(() => {
      setCopiedCallbackUrl(false);
      copiedCallbackTimer = null;
    }, 2000);
    exchangeTimer = clearTimer(exchangeTimer);
    await oauthExchange();
  }

  async function callbackPaste(event: ClipboardEvent) {
    if (readonly() || isLoading()) return;

    const pastedText = event.clipboardData?.getData("text").trim();
    if (!pastedText) return;

    event.preventDefault();
    setCallbackUrl(pastedText);
    exchangeTimer = clearTimer(exchangeTimer);
    await oauthExchange();
  }

  function goBack() {
    copyTimer = clearTimer(copyTimer);
    const previousStep = step();
    let nextStep = Math.max(minimumStep(), step() - 1);
    if (nextStep === authStep() && previousStep === finishStep() && isCustomProvider(provider())) {
      nextStep = Math.max(minimumStep(), authStep() - 1);
    }
    setStep(nextStep);

    if (nextStep === 1) {
      setProvider(null);
      setSelectedMethod(null);
      return;
    }

    if (nextStep === 2) {
      setSelectedMethod(null);
    }
  }

  function backPolling() {
    copyTimer = clearTimer(copyTimer);
    resetProgress();
    setStep(authStep());
  }

  onCleanup(() => {
    pollingTimer = clearTimer(pollingTimer);
    copiedLinkTimer = clearTimer(copiedLinkTimer);
    copiedCodeTimer = clearTimer(copiedCodeTimer);
    copiedCallbackTimer = clearTimer(copiedCallbackTimer);
    exchangeTimer = clearTimer(exchangeTimer);
    copyTimer = clearTimer(copyTimer);
  });

  return {
    customList,
    open,
    setOpen,
    customMode,
    minimumStep,
    step,
    setStep,
    provider,
    callbackUrl,
    setCallbackUrl,
    chatgptSessionJson,
    setChatgptSessionJson,
    apiKey,
    setApiKey,
    platformKey,
    setPlatformKey,
    cfAccountId,
    setCfAccountId,
    authUrl,
    selectedMethod,
    deviceCodeInfo,
    copiedLink,
    copiedDeviceCode,
    copiedCallbackUrl,
    apiKeyVisible,
    setApiKeyVisible,
    isLoading,
    isFetchingUrl,
    isPolling,
    errorMessage,
    selectedConfig,
    activeFlowType,
    authStep,
    finishStep,
    dialogOpen: open,
    setDialogOpen,
    displayedSteps,
    preventOutsideClose,
    customCreated: handleCustomCreated,
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
