import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderAccountKey } from "../lib/provider-accounts";
import { cn } from "../lib/utils";
import { useDashboardApi } from "../hooks/useDashboardApi";
import { useDashboardDataInvalidation } from "../hooks/useDashboardDataInvalidation";
import { UiButton } from "./ui/UiButton";
import { UiDialog } from "./ui/UiDialog";
import { UiIcon } from "./ui/UiIcon";
import { UiTooltip } from "./ui/UiTooltip";

type Provider = ProviderAccountKey;
type FlowType = "oauth_redirect" | "device_code" | "chatgpt_session" | "api_key" | "api_key_with_account_id";
type MethodKey = FlowType;

interface ProviderMethod {
  key: MethodKey;
  flow?: FlowType;
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

const browserOAuthMethod: ProviderMethod = { key: "oauth_redirect", name: "Browser OAuth", description: "Login in your browser." };
const deviceCodeMethod: ProviderMethod = { key: "device_code", name: "Device Code", description: "Enter a short device code." };
const apiKeyMethod: ProviderMethod = { key: "api_key", name: "API Key", description: "Create or copy an API key from the provider portal." };
const apiTokenWithAccountIdMethod: ProviderMethod = { key: "api_key_with_account_id", name: "API Token", description: "Requires the matching account ID." };

const providerConfigs: Record<Provider, ProviderConfig> = {
  antigravity: { name: "Antigravity", description: "Access Gemini & Claude via Google OAuth", methods: [browserOAuthMethod] },
  codex: { name: "Codex", description: "Access GPT-5 Codex models", methods: [browserOAuthMethod, deviceCodeMethod, { key: "chatgpt_session", name: "ChatGPT Session", description: "Use an active web session.", disabled: true }] },
  command_code: { name: "Command Code", description: "Access open-source models via the Go tier ($1/mo) CLI API key", methods: [apiKeyMethod], apiKeyPortalUrl: "https://commandcode.ai/studio/api-keys", apiKeyPlaceholder: "user_..." },
  kiro: { name: "Kiro", description: "Access Claude via Kiro OAuth", methods: [browserOAuthMethod] },
  nvidia_nim: { name: "Nvidia", description: "Access NIM models with direct API key", methods: [apiKeyMethod], apiKeyPortalUrl: "https://build.nvidia.com/settings/api-keys", apiKeyPlaceholder: "nvapi-..." },
  openrouter: { name: "OpenRouter", description: "Access OpenRouter free models via API key", methods: [apiKeyMethod], apiKeyPortalUrl: "https://openrouter.ai/settings/keys", apiKeyPlaceholder: "sk-or-v1-..." },
  workers_ai: { name: "Cloudflare", description: "Access open-source models on Cloudflare's global network", methods: [apiTokenWithAccountIdMethod], apiKeyPortalUrl: "https://dash.cloudflare.com/?to=/:account/ai/workers-ai", apiKeyPlaceholder: "Bearer token...", accountIdPlaceholder: "e.g. 1a2b3c4d5e6f...", accountIdLabel: "Cloudflare Account ID" },
  qoder: { name: "Qoder", description: "Access Qoder models via browser login or PAT", methods: [deviceCodeMethod, apiKeyMethod], apiKeyPortalUrl: "https://qoder.com/account/integrations", apiKeyPlaceholder: "pt-..." },
  zenmux: { name: "ZenMux", description: "Access ZenMux free models via API key", methods: [apiKeyMethod], apiKeyPortalUrl: "https://zenmux.ai/platform/pay-as-you-go", apiKeyPlaceholder: "sk-..." },
  siliconflow: { name: "SiliconFlow", description: "Access DeepSeek, Qwen, GLM & more via API key", methods: [apiKeyMethod], apiKeyPortalUrl: "https://cloud.siliconflow.com/account/ak", apiKeyPlaceholder: "sk-..." },
};

const chatgptSessionPlaceholder = `{
  "WARNING_BANNER": "!!!!!!!!!!!!!!!!!!!! DO NOT SHARE ANY PART OF THE INFORMATION YOU SEE HERE. THIS INFORMATION IS SENSITIVE AND CAN GRANT ACCESS TO YOUR ACCOUNT. !!!!!!!!!!!!!!!!!!!!",
  "user": { "email": "you@example.com" },
  "expires": "2026-08-16T22:42:05.747Z",
  "account": { "id": "b975c0c5-b667-4aa8-ac89-ce4ec41c6357", "planType": "free" },
  "accessToken": "eyJ...",
  "authProvider": "openai",
  "sessionToken": "eyJ..."
}`;

function callbackPlaceholder(provider: Provider | null) {
  if (!provider) return "https://...";
  if (provider === "antigravity") return "https://localhost:3001";
  if (provider === "codex") return "https://chatgpt.com/";
  if (provider === "kiro") return "https://q.aws.amazon.com/";
  return "https://...";
}

export interface AddAccountDialogProps {
  initialProvider?: Provider | null;
  triggerClass?: string;
  readonly?: boolean;
  onConnected?: (result: { provider: Provider; email: string; isUpdate: boolean }) => void;
}

export function AddAccountDialog({ initialProvider, triggerClass, readonly, onConnected }: AddAccountDialogProps) {
  const dashboardApi = useDashboardApi();
  const dashboardInvalidation = useDashboardDataInvalidation();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [selectedMethod, setSelectedMethod] = useState<MethodKey | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [chatgptSessionJson, setChatgptSessionJson] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [platformKey, setPlatformKey] = useState("");
  const [cfAccountId, setCfAccountId] = useState("");
  const [authUrl, setAuthUrl] = useState("");
  const [oauthState, setOauthState] = useState<string | null>(null);
  const [oauthCodeVerifier, setOauthCodeVerifier] = useState<string | null>(null);
  const [deviceCodeInfo, setDeviceCodeInfo] = useState<{ provider: "codex" | "qoder"; deviceCode: string; userCode: string; verificationUrl: string; codeVerifier?: string; machineId?: string } | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedDeviceCode, setCopiedDeviceCode] = useState(false);
  const [copiedCallbackUrl, setCopiedCallbackUrl] = useState(false);
  const [isApiKeyVisible, setIsApiKeyVisible] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetchingUrl, setIsFetchingUrl] = useState(false);
  const [isPolling, setIsPolling] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const pollingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const callbackAutoExchangeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popupRef = useRef<Window | null>(null);

  const selectedConfig = provider ? providerConfigs[provider] : null;
  const activeFlowType = selectedMethod ?? (selectedConfig?.methods[0]?.key ?? null);
  const minimumStep = 1;

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setProvider(initialProvider ?? null);
    setSelectedMethod(null);
    resetForm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    return () => {
      if (pollingTimer.current) clearTimeout(pollingTimer.current);
      copyTimers.current.forEach(clearTimeout);
      if (callbackAutoExchangeTimer.current) clearTimeout(callbackAutoExchangeTimer.current);
    };
  }, []);

  const resetForm = () => {
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
    setIsApiKeyVisible(false);
    setIsLoading(false);
    setIsFetchingUrl(false);
    setIsPolling(false);
    setErrorMessage("");
  };

  const stopPolling = (keepStatus = false) => {
    if (pollingTimer.current) {
      clearTimeout(pollingTimer.current);
      pollingTimer.current = null;
    }
    if (!keepStatus) setIsPolling(false);
  };

  const finishConnection = (result: { email: string; isUpdate: boolean }) => {
    if (!provider) return;
    stopPolling();
    if (popupRef.current && !popupRef.current.closed) popupRef.current.close();
    setOpen(false);
    onConnected?.({ provider, ...result });
    dashboardInvalidation.invalidateAccountCollection(provider);
  };

  const selectProvider = (providerKey: Provider) => {
    setProvider(providerKey);
    setSelectedMethod(null);
    setStep(2);
  };

  const selectLoginMethod = (method: MethodKey) => {
    setSelectedMethod(method);
    setErrorMessage("");
    setAuthUrl("");
    setOauthState(null);
    setOauthCodeVerifier(null);
    setDeviceCodeInfo(null);
    setCopiedLink(false);
    setCopiedDeviceCode(false);
    setCopiedCallbackUrl(false);
    setIsFetchingUrl(false);
    setIsPolling(false);
    setStep(3);
    void prepareAuthFlow(method);
  };

  const prepareAuthFlow = async (method: MethodKey) => {
    if (!provider) return;
    setIsFetchingUrl(true);
    setErrorMessage("");
    try {
      if (method === "oauth_redirect") {
        const result = await dashboardApi.accounts.getAuthUrl({ provider: provider as "antigravity" | "codex" | "kiro" });
        if (!result.success) throw new Error(result.error);
        setAuthUrl(result.data.authUrl);
        setOauthState(result.data.state);
        setOauthCodeVerifier(result.data.codeVerifier);
      } else if (method === "device_code") {
        const result = await dashboardApi.accounts.initiateDeviceAuth({ provider: provider as "codex" | "qoder" });
        if (!result.success) throw new Error(result.error);
        const data = result.data as { deviceCode: string; userCode: string; verificationUrl: string; verificationUrlComplete?: string; codeVerifier?: string; machineId?: string };
        setDeviceCodeInfo({
          provider: provider as "codex" | "qoder",
          deviceCode: data.deviceCode,
          userCode: data.userCode,
          verificationUrl: data.verificationUrlComplete || data.verificationUrl,
          codeVerifier: typeof data.codeVerifier === "string" ? data.codeVerifier : undefined,
          machineId: typeof data.machineId === "string" ? data.machineId : undefined,
        });
      } else if (method === "api_key" || method === "api_key_with_account_id") {
        setAuthUrl(providerConfigs[provider].apiKeyPortalUrl ?? "");
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to start account connection");
    } finally {
      setIsFetchingUrl(false);
    }
  };

  const openPopup = (url: string, name: string, width: number, height: number) => {
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;
    popupRef.current = window.open(url, name, `popup=yes,width=${width},height=${height},left=${left},top=${top}`);
  };

  const openOAuthUrl = () => {
    if (!authUrl) return;
    openPopup(authUrl, "oauth_popup", 600, 700);
    window.setTimeout(() => setStep(4), 600);
  };

  const startDevicePolling = () => {
    if (!deviceCodeInfo) return;
    setIsPolling(true);
    let intervalMs = 5000;
    const poll = async () => {
      try {
        const result = await dashboardApi.accounts.pollDeviceAuth({
          provider: deviceCodeInfo.provider,
          deviceCode: deviceCodeInfo.deviceCode,
          codeVerifier: deviceCodeInfo.codeVerifier,
          machineId: deviceCodeInfo.machineId,
        });
        if (!result.success) throw new Error(result.error);
        const data = result.data as { status: "pending" | "error" | "success"; message?: string; retryAfterSeconds?: number; email: string; isUpdate: boolean };
        if (data.status === "success") {
          finishConnection({ email: data.email, isUpdate: data.isUpdate });
          return;
        }
        if (data.status === "error") {
          setErrorMessage(data.message ?? "Authorization failed");
          stopPolling(true);
          return;
        }
        if (typeof data.retryAfterSeconds === "number" && data.retryAfterSeconds > 0) {
          intervalMs = data.retryAfterSeconds * 1000;
        }
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Failed to check authorization status");
      }
      pollingTimer.current = setTimeout(() => void poll(), intervalMs);
    };
    pollingTimer.current = setTimeout(() => void poll(), intervalMs);
  };

  const openDeviceAuthUrl = () => {
    if (!deviceCodeInfo) return;
    openPopup(deviceCodeInfo.verificationUrl, "device_auth_popup", 600, 700);
    startDevicePolling();
  };

  const handleConnectApiKey = async () => {
    if (readonly || !provider || !selectedConfig) return;
    setErrorMessage("");
    if (!apiKey.trim()) {
      setErrorMessage(activeFlowType === "api_key_with_account_id" ? "Please enter an API token" : "Please enter an API key");
      return;
    }
    if (provider === "zenmux" && !platformKey.trim()) {
      setErrorMessage("Please enter a Platform Key. Get it from ZenMux → Management → API Keys.");
      return;
    }
    if (activeFlowType === "api_key_with_account_id" && !cfAccountId.trim()) {
      setErrorMessage(`Please enter the ${selectedConfig.accountIdLabel}`);
      return;
    }
    setIsLoading(true);
    try {
      const result = await dashboardApi.accounts.create({ provider, token: apiKey.trim(), cfAccountId: cfAccountId.trim() || undefined, platformKey: platformKey.trim() || undefined });
      if (!result.success) throw new Error(result.error);
      finishConnection(result.data);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to connect account");
    } finally {
      setIsLoading(false);
    }
  };

  const handleConnectCodexSession = async () => {
    if (readonly) return;
    setErrorMessage("");
    if (!chatgptSessionJson.trim()) {
      setErrorMessage("Please paste the ChatGPT session");
      return;
    }
    setIsLoading(true);
    try {
      const result = await dashboardApi.accounts.connectCodexSession({ sessionJson: chatgptSessionJson.trim() });
      if (!result.success) throw new Error(result.error);
      finishConnection(result.data);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to connect account");
    } finally {
      setIsLoading(false);
    }
  };

  const handleExchangeOAuth = async () => {
    if (readonly || !provider) return;
    setErrorMessage("");
    if (!callbackUrl.trim()) {
      setErrorMessage("Please paste the callback URL");
      return;
    }
    if (!callbackUrl.includes("code=")) {
      setErrorMessage("Invalid URL. Make sure the URL contains 'code=' parameter.");
      return;
    }
    setIsLoading(true);
    try {
      const result = await dashboardApi.accounts.exchangeOAuth({ provider: provider as "antigravity" | "codex" | "kiro", callbackUrl: callbackUrl.trim(), state: oauthState, codeVerifier: oauthCodeVerifier });
      if (!result.success) throw new Error(result.error);
      finishConnection(result.data);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to connect account");
    } finally {
      setIsLoading(false);
    }
  };

  const handleCallbackInput = (value: string) => {
    setCallbackUrl(value);
    if (callbackAutoExchangeTimer.current) clearTimeout(callbackAutoExchangeTimer.current);
    if (readonly || isLoading) return;
    try {
      const url = new URL(value);
      if (!url.searchParams.get("code")) return;
    } catch {
      return;
    }
    callbackAutoExchangeTimer.current = setTimeout(() => {
      callbackAutoExchangeTimer.current = null;
      void handleExchangeOAuth();
    }, 300);
  };

  const pasteCallbackUrl = async () => {
    if (readonly || isLoading) return;
    try {
      const value = await navigator.clipboard.readText();
      setCallbackUrl(value.trim());
      setCopiedCallbackUrl(true);
      if (callbackAutoExchangeTimer.current) clearTimeout(callbackAutoExchangeTimer.current);
      await handleExchangeOAuth();
    } catch {
      setErrorMessage("Failed to paste callback URL");
    }
  };

  const copyText = async (text: string, target: "link" | "code") => {
    try {
      await navigator.clipboard.writeText(text);
      if (target === "link") {
        setCopiedLink(true);
        copyTimers.current.push(setTimeout(() => setCopiedLink(false), 2000));
      } else {
        setCopiedDeviceCode(true);
        copyTimers.current.push(setTimeout(() => setCopiedDeviceCode(false), 2000));
      }
    } catch {
      setErrorMessage(target === "link" ? "Failed to copy link" : "Failed to copy code");
    }
  };

  const openApiKeyPortal = () => {
    if (!authUrl) return;
    openPopup(authUrl, "api_key_portal", 1100, 760);
    window.setTimeout(() => setStep(4), 600);
  };

  const goBack = () => {
    stopPolling();
    resetForm();
    setStep((current) => Math.max(minimumStep, current - 1));
  };

  const steps = ["Provider", "Method", "Login", "Connect"];
  const authStep = 3;
  const finishStep = 4;

  return (
    <>
      <UiButton variant="outline" className={cn("flex-1 sm:w-auto sm:flex-none", triggerClass)} disabled={readonly} onClick={() => setOpen(true)}>
        <UiIcon name="i-lucide-plus" className="size-4" />
        Add Account
      </UiButton>

      <UiDialog open={open} onOpenChange={setOpen}>
        <div className="flex items-center gap-1 pr-6">
          {steps.map((label, index) => {
            const stepNumber = index + 1;
            return (
              <div key={label} className="flex items-center">
                <div className={cn("flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium transition-colors", step >= stepNumber ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
                  {step > stepNumber ? <UiIcon name="i-lucide-check" className="size-4" /> : <span>{index + 1}</span>}
                </div>
                {index < steps.length - 1 ? <div className={cn("h-px w-10 transition-colors", step > stepNumber ? "bg-primary" : "bg-border")} /> : null}
              </div>
            );
          })}
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
          {step === 1 ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {(Object.keys(providerConfigs) as Provider[]).map((providerKey) => (
                <button
                  key={providerKey}
                  type="button"
                  className={cn("flex cursor-pointer flex-col items-center gap-2 rounded-lg border p-3 text-center transition-colors hover:bg-muted/40", provider === providerKey ? "border-foreground/30 bg-muted/30" : "border-border")}
                  onClick={() => selectProvider(providerKey)}
                >
                  <span className="text-sm font-medium">{providerConfigs[providerKey].name}</span>
                </button>
              ))}
            </div>
          ) : null}

          {step === 2 && selectedConfig ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <p className="text-sm font-medium">Choose {selectedConfig.name} method</p>
              </div>
              <div className="grid gap-3">
                {selectedConfig.methods.map((method) => (
                  <button
                    key={method.key}
                    type="button"
                    disabled={method.disabled}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
                      selectedMethod === method.key ? "border-foreground/30 bg-muted/30" : "border-border",
                    )}
                    onClick={() => selectLoginMethod(method.key)}
                  >
                    <span className="space-y-1">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        {method.name}
                        {method.tag ? <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{method.tag}</span> : null}
                        {method.disabled ? <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">Unavailable</span> : null}
                      </span>
                      <span className="block text-xs text-muted-foreground">{method.description}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {(step === authStep || (step === finishStep && activeFlowType === "device_code" && isPolling)) && selectedConfig && activeFlowType ? (
            <div className="space-y-4">
              {activeFlowType === "oauth_redirect" ? (
                <>
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Login to {selectedConfig.name}</p>
                    <p className="text-sm text-muted-foreground">
                      Click the button below to open the login page in a new window. After logging in, you'll be redirected to a page that shows an error - this is expected.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <UiButton variant="outline" className="flex-1" disabled={isFetchingUrl || !authUrl} onClick={openOAuthUrl}>
                      <UiIcon name={isFetchingUrl ? "i-lucide-loader-2" : "i-lucide-external-link"} className={cn("size-4", isFetchingUrl ? "animate-spin" : "")} />
                      Open {selectedConfig.name} Login
                    </UiButton>
                    <UiTooltip text={copiedLink ? "Copied" : "Copy link"}>
                      <UiButton variant="outline" disabled={isFetchingUrl || !authUrl} onClick={() => void copyText(authUrl, "link")}>
                        <UiIcon name={copiedLink ? "i-lucide-check" : "i-lucide-copy"} className="size-4" />
                      </UiButton>
                    </UiTooltip>
                  </div>
                  <div className="relative w-full rounded-lg border px-4 py-3 text-sm">
                    <UiIcon name="i-lucide-alert-circle" className="absolute left-4 top-4 size-4" />
                    <div className="pl-7 text-xs">
                      After login, copy the URL from address bar: <code className="rounded bg-muted px-1">{callbackPlaceholder(provider)}</code>
                    </div>
                  </div>
                </>
              ) : null}

              {activeFlowType === "device_code" ? (
                <>
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Login to {selectedConfig.name}</p>
                    <p className="text-sm text-muted-foreground">
                      Click the button below to open the provider login page. Enter the code shown below on the provider login page. After you complete the login, authorization will be detected automatically.
                    </p>
                  </div>
                  {deviceCodeInfo?.userCode ? (
                    <div className="rounded-md border border-border bg-muted/30 p-3">
                      <p className="text-xs text-muted-foreground">Enter this code on the provider page:</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <code className="rounded bg-background px-2 py-1 font-mono text-sm font-semibold tracking-[0.15em]">{deviceCodeInfo.userCode}</code>
                        <UiButton type="button" size="sm" variant="outline" onClick={() => void copyText(deviceCodeInfo.userCode, "code")}>
                          <UiIcon name={copiedDeviceCode ? "i-lucide-check" : "i-lucide-copy"} className="size-3.5" />
                          {copiedDeviceCode ? "Copied" : "Copy code"}
                        </UiButton>
                      </div>
                    </div>
                  ) : null}
                  <div className="flex gap-2">
                    <UiButton variant="outline" className="flex-1" disabled={isFetchingUrl || !deviceCodeInfo} onClick={openDeviceAuthUrl}>
                      <UiIcon name={isFetchingUrl ? "i-lucide-loader-2" : "i-lucide-external-link"} className={cn("size-4", isFetchingUrl ? "animate-spin" : "")} />
                      Open {selectedConfig.name} Login
                    </UiButton>
                    <UiTooltip text={copiedLink ? "Copied" : "Copy link"}>
                      <UiButton variant="outline" disabled={isFetchingUrl || !deviceCodeInfo} onClick={() => deviceCodeInfo && void copyText(deviceCodeInfo.verificationUrl, "link")}>
                        <UiIcon name={copiedLink ? "i-lucide-check" : "i-lucide-copy"} className="size-4" />
                      </UiButton>
                    </UiTooltip>
                  </div>
                  {isPolling ? (
                    <div className="relative w-full rounded-lg border px-4 py-3 text-sm">
                      <UiIcon name="i-lucide-loader-2" className="absolute left-4 top-4 size-4 animate-spin" />
                      <div className="pl-7 text-xs">Complete the login in your browser. This dialog will close automatically when authorization is complete.</div>
                    </div>
                  ) : null}
                </>
              ) : null}

              {activeFlowType === "chatgpt_session" ? (
                <>
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Copy ChatGPT session</p>
                    <p className="text-sm text-muted-foreground">
                      Open the session page while logged in to ChatGPT, copy the full response, then paste it here. This method has no refresh token, so reconnect when the access token expires.
                    </p>
                  </div>
                  <div className="rounded-md border border-border bg-muted/30 p-3">
                    <p className="break-all text-xs text-muted-foreground">https://chatgpt.com/api/auth/session</p>
                  </div>
                  <div className="flex gap-2">
                    <UiButton type="button" variant="outline" className="flex-1" onClick={() => openPopup("https://chatgpt.com/api/auth/session", "chatgpt_session", 1100, 760)}>
                      <UiIcon name="i-lucide-external-link" className="size-4" />
                      Open Session Page
                    </UiButton>
                    <UiTooltip text={copiedLink ? "Copied" : "Copy link"}>
                      <UiButton type="button" variant="outline" onClick={() => void copyText("https://chatgpt.com/api/auth/session", "link")}>
                        <UiIcon name={copiedLink ? "i-lucide-check" : "i-lucide-copy"} className="size-4" />
                      </UiButton>
                    </UiTooltip>
                  </div>
                </>
              ) : null}

              {activeFlowType === "api_key" || activeFlowType === "api_key_with_account_id" ? (
                <>
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Get {selectedConfig.name} API Key</p>
                    <p className="text-sm text-muted-foreground">Open the provider page below and create or copy your API key. You will continue to the next step automatically.</p>
                  </div>
                  <div className="rounded-md border border-border bg-muted/30 p-3">
                    <p className="break-all text-xs text-muted-foreground">{selectedConfig.apiKeyPortalUrl}</p>
                  </div>
                  <div className="flex gap-2">
                    <UiButton type="button" variant="outline" className="flex-1" onClick={openApiKeyPortal}>
                      <UiIcon name="i-lucide-external-link" className="size-4" />
                      Open {selectedConfig.name} Portal
                    </UiButton>
                    <UiTooltip text={copiedLink ? "Copied" : "Copy link"}>
                      <UiButton type="button" variant="outline" onClick={() => authUrl && void copyText(authUrl, "link")}>
                        <UiIcon name={copiedLink ? "i-lucide-check" : "i-lucide-copy"} className="size-4" />
                      </UiButton>
                    </UiTooltip>
                  </div>
                </>
              ) : null}

              {errorMessage ? (
                <div className="relative w-full rounded-lg border border-destructive/50 px-4 py-3 text-sm text-destructive">
                  <UiIcon name="i-lucide-alert-circle" className="absolute left-4 top-4 size-4" />
                  <div className="pl-7 text-xs">{errorMessage}</div>
                </div>
              ) : null}
            </div>
          ) : null}

          {step === finishStep && selectedConfig && activeFlowType === "oauth_redirect" ? (
            <form className="space-y-4" onSubmit={(event) => event.preventDefault()}>
              <div className="space-y-2">
                <label htmlFor="callback-url" className="text-sm font-medium">
                  Paste Callback URL <span aria-hidden="true" className="text-destructive">*</span>
                </label>
                <p className="text-sm text-muted-foreground">Paste the URL from your browser after the OAuth redirect.</p>
                <div className="relative">
                  <input
                    id="callback-url"
                    value={callbackUrl}
                    onChange={(event) => handleCallbackInput(event.target.value)}
                    type="text"
                    placeholder={callbackPlaceholder(provider)}
                    disabled={isLoading}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 pr-9 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
                  />
                  <UiTooltip text={copiedCallbackUrl ? "Pasted" : "Paste"}>
                    <button
                      type="button"
                      disabled={isLoading}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                      aria-label="Paste callback URL"
                      onClick={() => void pasteCallbackUrl()}
                    >
                      <UiIcon name={isLoading ? "i-lucide-loader-2" : copiedCallbackUrl ? "i-lucide-check" : "i-lucide-clipboard-paste"} className={cn("size-4", isLoading ? "animate-spin" : "")} />
                    </button>
                  </UiTooltip>
                </div>
                {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}
              </div>
            </form>
          ) : null}

          {step === finishStep && selectedConfig && activeFlowType === "chatgpt_session" ? (
            <form className="space-y-4" autoComplete="off" data-lpignore="true" onSubmit={(event) => { event.preventDefault(); void handleConnectCodexSession(); }}>
              <div className="space-y-2">
                <label htmlFor="chatgpt-session-json" className="text-sm font-medium">
                  Paste Session <span aria-hidden="true" className="text-destructive">*</span>
                </label>
                <p className="text-sm text-muted-foreground">
                  Paste the full response from <code className="rounded bg-muted px-1">chatgpt.com/api/auth/session</code>.
                </p>
                <textarea
                  id="chatgpt-session-json"
                  value={chatgptSessionJson}
                  onChange={(event) => setChatgptSessionJson(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  data-lpignore="true"
                  disabled={isLoading}
                  placeholder={chatgptSessionPlaceholder}
                  className="min-h-36 w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
                />
              </div>
              {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}
              <UiButton type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? <UiIcon name="i-lucide-loader-2" className="size-4 animate-spin" /> : null}
                {isLoading ? "Connecting..." : "Connect Codex Account"}
              </UiButton>
            </form>
          ) : null}

          {step === finishStep && selectedConfig && (activeFlowType === "api_key" || activeFlowType === "api_key_with_account_id") ? (
            <form className="space-y-4" autoComplete="off" data-lpignore="true" onSubmit={(event) => { event.preventDefault(); void handleConnectApiKey(); }}>
              <div className="space-y-2">
                <p className="text-sm font-medium">Connect {selectedConfig.name}</p>
                <p className="text-sm text-muted-foreground">
                  {activeFlowType === "api_key_with_account_id" ? "Paste your API token and Account ID. Credentials will be stored encrypted." : "Paste your provider API key directly. The key will be stored encrypted."}
                </p>
              </div>
              <div className="space-y-2">
                <label htmlFor="provider-api-key" className="text-sm font-medium">
                  {activeFlowType === "api_key_with_account_id" ? "API Token" : "API Key"} <span aria-hidden="true" className="text-destructive">*</span>
                </label>
                <div className="relative">
                  <input
                    id="provider-api-key"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    data-lpignore="true"
                    placeholder={selectedConfig.apiKeyPlaceholder}
                    disabled={isLoading}
                    className={cn(
                      "h-9 w-full rounded-md border border-input bg-background px-3 pr-9 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50",
                      isApiKeyVisible ? "" : "[text-security:disc] [-webkit-text-security:disc]",
                    )}
                  />
                  <UiTooltip text={isApiKeyVisible ? "Hide" : "Show"}>
                    <button
                      type="button"
                      disabled={isLoading}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                      aria-label={isApiKeyVisible ? "Hide API key" : "Show API key"}
                      onClick={() => setIsApiKeyVisible(!isApiKeyVisible)}
                    >
                      <UiIcon name={isApiKeyVisible ? "i-lucide-eye-off" : "i-lucide-eye"} className="size-4" />
                    </button>
                  </UiTooltip>
                </div>
              </div>

              {provider === "zenmux" ? (
                <div className="space-y-2">
                  <label htmlFor="provider-platform-key" className="text-sm font-medium">
                    Platform Key <span aria-hidden="true" className="text-destructive">*</span>
                  </label>
                  <p className="text-xs text-muted-foreground">
                    For quota usage tracking. <a href="https://zenmux.ai/platform/management" target="_blank" rel="noreferrer" className="underline">Get from ZenMux → Management → API Keys</a>
                  </p>
                  <input
                    id="provider-platform-key"
                    value={platformKey}
                    onChange={(event) => setPlatformKey(event.target.value)}
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    data-lpignore="true"
                    placeholder="sk-mg-v1-..."
                    disabled={isLoading}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
                  />
                </div>
              ) : null}

              {activeFlowType === "api_key_with_account_id" ? (
                <div className="space-y-2">
                  <label htmlFor="provider-account-id" className="text-sm font-medium">
                    {selectedConfig.accountIdLabel} <span aria-hidden="true" className="text-destructive">*</span>
                  </label>
                  <input
                    id="provider-account-id"
                    value={cfAccountId}
                    onChange={(event) => setCfAccountId(event.target.value)}
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    data-lpignore="true"
                    placeholder={selectedConfig.accountIdPlaceholder}
                    disabled={isLoading}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
                  />
                </div>
              ) : null}

              {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}

              <UiButton type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? <UiIcon name="i-lucide-loader-2" className="size-4 animate-spin" /> : null}
                {isLoading ? "Connecting..." : `Connect ${selectedConfig.name} Account`}
              </UiButton>
            </form>
          ) : null}
        </div>

        <div className="flex flex-row items-center justify-between gap-2">
          {isPolling ? (
            <UiButton type="button" variant="ghost" onClick={goBack}>
              <UiIcon name="i-lucide-arrow-left" className="size-4" />
              Back
            </UiButton>
          ) : null}
          {step > minimumStep && !isPolling ? (
            <UiButton type="button" variant="ghost" disabled={isLoading} onClick={goBack}>
              <UiIcon name="i-lucide-arrow-left" className="size-4" />
              Back
            </UiButton>
          ) : null}
          {step === authStep && selectedConfig && activeFlowType !== "device_code" ? (
            <UiButton type="button" variant="ghost" className="ml-auto" onClick={() => setStep(finishStep)}>
              Next
              <UiIcon name="i-lucide-arrow-right" className="size-4" />
            </UiButton>
          ) : null}
        </div>
      </UiDialog>
    </>
  );
}
