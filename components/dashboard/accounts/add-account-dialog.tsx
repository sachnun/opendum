"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Loader2,
  ExternalLink,
  AlertCircle,
  Plus,
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
} from "lucide-react";
import { toast } from "sonner";
import {
  exchangeIflowOAuthCode,
  exchangeAntigravityOAuthCode,
  exchangeGeminiCliOAuthCode,
  exchangeCodexOAuthCode,
  exchangeKiroOAuthCode,
  getIflowAuthUrl,
  getAntigravityAuthUrl,
  getGeminiCliAuthUrl,
  getCodexAuthUrl,
  getKiroAuthUrl,
  initiateQwenCodeAuth,
  pollQwenCodeAuth,
  connectNvidiaNimApiKey,
  connectOllamaCloudApiKey,
  connectOpenRouterApiKey,
} from "@/lib/actions/accounts";
import { cn } from "@/lib/utils";

type Provider =
  | "iflow"
  | "antigravity"
  | "qwen_code"
  | "gemini_cli"
  | "codex"
  | "kiro"
  | "nvidia_nim"
  | "ollama_cloud"
  | "openrouter"
  | null;

interface OAuthRedirectConfig {
  flowType: "oauth_redirect";
  getAuthUrl: () => Promise<{ success: true; data: { authUrl: string } } | { success: false; error: string }>;
  exchangeAction: (callbackUrl: string) => Promise<{ success: true; data: { email: string; isUpdate: boolean } } | { success: false; error: string }>;
}

interface DeviceCodeConfig {
  flowType: "device_code";
}

interface ApiKeyConfig {
  flowType: "api_key";
  apiKeyPortalUrl: string;
  apiKeyPlaceholder: string;
  accountNamePlaceholder: string;
  connectAction: (
    apiKey: string,
    accountName?: string
  ) => Promise<
    | { success: true; data: { email: string; isUpdate: boolean } }
    | { success: false; error: string }
  >;
}

interface ProviderConfig {
  name: string;
  description: string;
}

type ProviderFullConfig = ProviderConfig &
  (OAuthRedirectConfig | DeviceCodeConfig | ApiKeyConfig);

const PROVIDERS: Record<Exclude<Provider, null>, ProviderFullConfig> = {
  iflow: {
    name: "Iflow",
    description: "Access OpenAI compatible API",
    flowType: "oauth_redirect",
    getAuthUrl: getIflowAuthUrl,
    exchangeAction: exchangeIflowOAuthCode,
  },
  antigravity: {
    name: "Antigravity",
    description: "Access Gemini & Claude via Google OAuth",
    flowType: "oauth_redirect",
    getAuthUrl: getAntigravityAuthUrl,
    exchangeAction: exchangeAntigravityOAuthCode,
  },
  gemini_cli: {
    name: "Gemini CLI",
    description: "Access Gemini 2.5 Pro & 3 models",
    flowType: "oauth_redirect",
    getAuthUrl: getGeminiCliAuthUrl,
    exchangeAction: exchangeGeminiCliOAuthCode,
  },
  qwen_code: {
    name: "Qwen Code",
    description: "Access Qwen Coder models",
    flowType: "device_code",
  },
  codex: {
    name: "Codex",
    description: "Access GPT-5 Codex models",
    flowType: "oauth_redirect",
    getAuthUrl: getCodexAuthUrl,
    exchangeAction: exchangeCodexOAuthCode,
  },
  kiro: {
    name: "Kiro",
    description: "Access Claude via Kiro OAuth",
    flowType: "oauth_redirect",
    getAuthUrl: getKiroAuthUrl,
    exchangeAction: exchangeKiroOAuthCode,
  },
  nvidia_nim: {
    name: "Nvidia",
    description: "Access NIM models with direct API key",
    flowType: "api_key",
    apiKeyPortalUrl: "https://build.nvidia.com/settings/api-keys",
    apiKeyPlaceholder: "nvapi-...",
    accountNamePlaceholder: "Nvidia Personal",
    connectAction: connectNvidiaNimApiKey,
  },
  ollama_cloud: {
    name: "Ollama Cloud",
    description: "Access Ollama Cloud via OpenAI-compatible API",
    flowType: "api_key",
    apiKeyPortalUrl: "https://ollama.com/settings/keys",
    apiKeyPlaceholder: "ollama_...",
    accountNamePlaceholder: "Ollama Cloud Personal",
    connectAction: connectOllamaCloudApiKey,
  },
  openrouter: {
    name: "OpenRouter",
    description: "Access OpenRouter free models via API key",
    flowType: "api_key",
    apiKeyPortalUrl: "https://openrouter.ai/settings/keys",
    apiKeyPlaceholder: "sk-or-v1-...",
    accountNamePlaceholder: "OpenRouter Personal",
    connectAction: connectOpenRouterApiKey,
  },
};

const OAUTH_PROVIDER_ORDER: Array<Exclude<Provider, null>> = [
  "antigravity",
  "codex",
  "kiro",
  "iflow",
  "gemini_cli",
  "qwen_code",
];

const API_KEY_PROVIDER_ORDER: Array<Exclude<Provider, null>> = [
  "nvidia_nim",
  "ollama_cloud",
  "openrouter",
];



interface AddAccountDialogProps {
  triggerClassName?: string;
}

export function AddAccountDialog({ triggerClassName }: AddAccountDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [provider, setProvider] = useState<Provider>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [isApiKeyVisible, setIsApiKeyVisible] = useState(false);
  const [accountName, setAccountName] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  
  // OAuth redirect flow state
  const [authUrl, setAuthUrl] = useState("");
  const [isFetchingUrl, setIsFetchingUrl] = useState(false);
  
  // Device code flow state
  const [deviceCodeInfo, setDeviceCodeInfo] = useState<{
    deviceCode: string;
    verificationUrl: string;
    codeVerifier?: string; // Qwen Code only (stored client-side)
  } | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  const providerConfig = provider ? PROVIDERS[provider] : null;
  const oauthProviders = OAUTH_PROVIDER_ORDER.map(
    (providerKey) => [providerKey, PROVIDERS[providerKey]] as const
  );
  const apiKeyProviders = API_KEY_PROVIDER_ORDER.map(
    (providerKey) => [providerKey, PROVIDERS[providerKey]] as const
  );

  // Cleanup polling on unmount or dialog close
  useEffect(() => {
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, []);

  // Fetch auth URL or initiate device code when entering step 2
  useEffect(() => {
    if (step === 2 && provider && providerConfig) {
      if (providerConfig.flowType === "oauth_redirect") {
        setIsFetchingUrl(true);
        setAuthUrl("");
        providerConfig.getAuthUrl()
          .then((result) => {
            if (result.success) {
              setAuthUrl(result.data.authUrl);
            } else {
              setError(result.error);
            }
          })
          .finally(() => setIsFetchingUrl(false));
      } else if (providerConfig.flowType === "device_code") {
        setIsFetchingUrl(true);
        setDeviceCodeInfo(null);

        // Qwen Code device code flow
        initiateQwenCodeAuth()
          .then((result) => {
            if (result.success) {
              setDeviceCodeInfo({
                deviceCode: result.data.deviceCode,
                verificationUrl: result.data.verificationUrlComplete,
                codeVerifier: result.data.codeVerifier,
              });
            } else {
              setError(result.error);
            }
          })
          .finally(() => setIsFetchingUrl(false));
      } else if (providerConfig.flowType === "api_key") {
        setIsFetchingUrl(false);
        setAuthUrl(providerConfig.apiKeyPortalUrl);
        setDeviceCodeInfo(null);
      } else {
        setIsFetchingUrl(false);
        setAuthUrl("");
        setDeviceCodeInfo(null);
      }
    }
  }, [step, provider, providerConfig]);

  const resetForm = useCallback(() => {
    setStep(1);
    setProvider(null);
    setCallbackUrl("");
    setApiKey("");
    setIsApiKeyVisible(false);
    setAccountName("");
    setError("");
    setIsLoading(false);
    setAuthUrl("");
    setIsFetchingUrl(false);
    setDeviceCodeInfo(null);
    setIsPolling(false);
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const handleOpenChange = (isOpen: boolean) => {
    if (!isLoading && !isPolling) {
      setOpen(isOpen);
      if (!isOpen) {
        resetForm();
      }
    }
  };

  const handleSelectProvider = (selectedProvider: Provider) => {
    setProvider(selectedProvider);
    setStep(2);
  };

  const handleStartOAuth = () => {
    if (!authUrl) return;

    const width = 600;
    const height = 700;
    const left = Math.round((window.screen.width - width) / 2);
    const top = Math.round((window.screen.height - height) / 2);

    const popup = window.open(
      authUrl,
      "oauth_popup",
      `width=${width},height=${height},left=${left},top=${top},scrollbars=yes,resizable=yes`
    );

    if (!popup || popup.closed) {
      window.open(authUrl, "_blank");
    }

    setStep(3);
  };

  const handleStartDeviceCodeAuth = () => {
    if (!deviceCodeInfo) return;

    // Open in centered popup window (same as OAuth flow)
    const width = 600;
    const height = 700;
    const left = Math.round((window.screen.width - width) / 2);
    const top = Math.round((window.screen.height - height) / 2);

    const popup = window.open(
      deviceCodeInfo.verificationUrl,
      "device_auth_popup",
      `width=${width},height=${height},left=${left},top=${top},scrollbars=yes,resizable=yes`
    );

    // Fallback to new tab if popup blocked
    if (!popup || popup.closed) {
      window.open(deviceCodeInfo.verificationUrl, "_blank");
      startPolling(null);
    } else {
      startPolling(popup);
    }
  };

  const startPolling = useCallback((popup: Window | null) => {
    if (!deviceCodeInfo || isPolling) return;

    setIsPolling(true);
    setError("");

    const poll = async () => {
      if (!deviceCodeInfo) return;

      // Check if popup was closed by user
      if (popup && popup.closed) {
        setIsPolling(false);
        setError("");
        if (pollingRef.current) {
          clearInterval(pollingRef.current);
          pollingRef.current = null;
        }
        return;
      }

      try {
        const result = await pollQwenCodeAuth(
          deviceCodeInfo.deviceCode,
          deviceCodeInfo.codeVerifier || ""
        );

        if (!result.success) {
          setError(result.error);
          setIsPolling(false);
          if (pollingRef.current) {
            clearInterval(pollingRef.current);
            pollingRef.current = null;
          }
          return;
        }

        if (result.data.status === "success") {
          // Close popup if still open
          if (popup && !popup.closed) {
            popup.close();
          }
          toast.success(
            result.data.isUpdate
              ? "Qwen Code account updated successfully!"
              : "Qwen Code account connected successfully!"
          );
          setOpen(false);
          resetForm();
          router.refresh();
          return;
        }

        if (result.data.status === "error") {
          const msg = typeof result.data.message === "string"
            ? result.data.message
            : "An error occurred";
          setError(msg);
          setIsPolling(false);
          if (pollingRef.current) {
            clearInterval(pollingRef.current);
            pollingRef.current = null;
          }
          return;
        }

        // status === "pending" - continue polling
      } catch (err) {
        console.error("Polling error:", err);
      }
    };

    // Initial poll
    poll();

    // Set up interval polling every 5 seconds
    pollingRef.current = setInterval(poll, 5000);
  }, [deviceCodeInfo, isPolling, resetForm, router]);

  const handleCopyLink = async () => {
    const urlToCopy = providerConfig?.flowType === "device_code" 
      ? deviceCodeInfo?.verificationUrl 
      : authUrl;

    if (urlToCopy) {
      try {
        await navigator.clipboard.writeText(urlToCopy);
        toast.success("Link copied to clipboard");
      } catch {
        toast.error("Failed to copy link");
      }

      if (step === 2 && providerConfig?.flowType === "api_key") {
        setStep(3);
      }
    }
  };

  const handleOpenApiKeyPortal = () => {
    if (!providerConfig || providerConfig.flowType !== "api_key") {
      return;
    }

    const portalUrl = providerConfig.apiKeyPortalUrl;
    const width = 1100;
    const height = 760;
    const left = Math.round((window.screen.width - width) / 2);
    const top = Math.round((window.screen.height - height) / 2);

    const popup = window.open(
      portalUrl,
      "api_key_portal_popup",
      `width=${width},height=${height},left=${left},top=${top},scrollbars=yes,resizable=yes`
    );

    if (!popup || popup.closed) {
      window.open(portalUrl, "_blank");
    }

    if (step === 2) {
      setStep(3);
    }
  };

  const handleConnectWithApiKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!providerConfig || providerConfig.flowType !== "api_key") {
      setError("Invalid provider configuration");
      return;
    }

    if (!apiKey.trim()) {
      setError("Please enter an API key");
      return;
    }

    setIsLoading(true);

    try {
      const result = await providerConfig.connectAction(
        apiKey.trim(),
        accountName.trim() || undefined
      );

      if (!result.success) {
        throw new Error(result.error);
      }

      const message = result.data.isUpdate
        ? `${providerConfig.name} account updated successfully!`
        : `${providerConfig.name} account connected successfully!`;

      toast.success(message);
      setOpen(false);
      resetForm();
      router.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to connect account";
      setError(message);
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!provider || !providerConfig || providerConfig.flowType !== "oauth_redirect") {
      setError("Invalid provider configuration");
      return;
    }

    if (!callbackUrl.trim()) {
      setError("Please paste the callback URL");
      return;
    }

    if (!callbackUrl.includes("code=")) {
      setError("Invalid URL. Make sure the URL contains 'code=' parameter.");
      return;
    }

    setIsLoading(true);

    try {
      const result = await providerConfig.exchangeAction(callbackUrl.trim());

      if (!result.success) {
        throw new Error(result.error);
      }

      const message = result.data.isUpdate
        ? `${providerConfig.name} account updated successfully!`
        : `${providerConfig.name} account connected successfully!`;

      toast.success(message);
      setOpen(false);
      resetForm();
      router.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to connect account";
      setError(message);
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button className={cn("gap-2", triggerClassName)}>
          <Plus className="h-4 w-4" />
          Add Account
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Provider Account</DialogTitle>
          <DialogDescription>
            Connect a new AI provider account for load balancing
          </DialogDescription>
        </DialogHeader>

        {/* Step Indicator */}
        <div className="flex items-center justify-center gap-2">
          {[1, 2, 3].map((s) => (
            <div key={s} className="flex items-center">
              <div
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium transition-colors",
                  step > s
                    ? "bg-primary text-primary-foreground"
                    : step === s
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                )}
              >
                {step > s ? <Check className="h-4 w-4" /> : s}
              </div>
              {s < 3 && (
                <div
                  className={cn(
                    "h-px w-8 transition-colors",
                    step > s ? "bg-primary" : "bg-border"
                  )}
                />
              )}
            </div>
          ))}
        </div>

        {/* Step Content */}
        <div className="min-h-[200px] space-y-4">
          {/* Step 1: Select Provider */}
          {step === 1 && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label className="text-sm font-medium">OAuth Providers</Label>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {oauthProviders.map(([key, config]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => handleSelectProvider(key)}
                      className={cn(
                        "flex flex-col items-center gap-2 rounded-lg border-2 p-3 text-center transition-all hover:border-primary hover:bg-accent",
                        provider === key
                          ? "border-primary bg-accent"
                          : "border-border"
                      )}
                    >
                      <div className="text-sm font-medium">{config.name}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-medium">API Key Providers</Label>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {apiKeyProviders.map(([key, config]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => handleSelectProvider(key)}
                      className={cn(
                        "flex flex-col items-center gap-2 rounded-lg border-2 p-3 text-center transition-all hover:border-primary hover:bg-accent",
                        provider === key
                          ? "border-primary bg-accent"
                          : "border-border"
                      )}
                    >
                      <div className="text-sm font-medium">{config.name}</div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Step 2: OAuth Login / Device Code */}
          {step === 2 && providerConfig && (
            <div className="space-y-4">
              {providerConfig.flowType === "oauth_redirect" ? (
                // OAuth Redirect Flow
                <>
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">
                      Login to {providerConfig.name}
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      Click the button below to open the login page in a new window.
                      After logging in, you&apos;ll be redirected to a page that shows
                      an error - this is expected.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={handleStartOAuth}
                      variant="outline"
                      className="flex-1"
                      disabled={isFetchingUrl || !authUrl}
                    >
                      {isFetchingUrl ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <ExternalLink className="mr-2 h-4 w-4" />
                      )}
                      Open {providerConfig.name} Login
                    </Button>
                    <Button
                      onClick={handleCopyLink}
                      variant="outline"
                      disabled={isFetchingUrl || !authUrl}
                      title="Copy login link"
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                  <Alert>
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription className="text-xs">
                      After login, copy the URL from address bar:{" "}
                        <code className="rounded bg-muted px-1">
                         {provider === "codex" || provider === "kiro"
                           ? "http://localhost:1455/auth/callback?code=..."
                           : "http://localhost:1/oauth2callback?code=..."}
                       </code>
                    </AlertDescription>
                  </Alert>
                </>
              ) : providerConfig.flowType === "device_code" ? (
                // Device Code Flow
                <>
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">
                      Login to {providerConfig.name}
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      Click the button below to open the Qwen login page. After
                      you complete the login, authorization will be detected
                      automatically.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={handleStartDeviceCodeAuth}
                      variant="outline"
                      className="flex-1"
                      disabled={isFetchingUrl || !deviceCodeInfo || isPolling}
                    >
                      {isFetchingUrl ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : isPolling ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <ExternalLink className="mr-2 h-4 w-4" />
                      )}
                      {isPolling ? "Waiting for login..." : `Open ${providerConfig.name} Login`}
                    </Button>
                    <Button
                      onClick={handleCopyLink}
                      variant="outline"
                      disabled={isFetchingUrl || !deviceCodeInfo}
                      title="Copy login link"
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                  {isPolling && (
                    <Alert>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <AlertDescription className="text-xs">
                        Complete the login in your browser. This dialog will close
                        automatically when authorization is complete.
                      </AlertDescription>
                    </Alert>
                  )}
                  {error && (
                    <Alert variant="destructive">
                      <AlertCircle className="h-4 w-4" />
                      <AlertDescription className="text-xs">{error}</AlertDescription>
                    </Alert>
                  )}
                </>
              ) : (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">
                      Get {providerConfig.name} API Key
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      Open the provider page below and create or copy your API key. You will continue to the next step automatically.
                    </p>
                  </div>

                  <div className="rounded-md border border-border bg-muted/30 p-3">
                    <p className="break-all text-xs text-muted-foreground">
                      {providerConfig.apiKeyPortalUrl}
                    </p>
                  </div>

                  <div className="flex gap-2">
                    <Button
                      type="button"
                      onClick={handleOpenApiKeyPortal}
                      variant="outline"
                      className="flex-1"
                    >
                      <ExternalLink className="mr-2 h-4 w-4" />
                      Open {providerConfig.name} Portal
                    </Button>
                    <Button
                      type="button"
                      onClick={handleCopyLink}
                      variant="outline"
                      title="Copy API key portal link"
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>

                </div>
              )}
            </div>
          )}

          {/* Step 3: Paste URL (OAuth Redirect only) */}
          {step === 3 && providerConfig && providerConfig.flowType === "oauth_redirect" && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label className="text-sm font-medium">Paste Callback URL</Label>
                <p className="text-sm text-muted-foreground">
                  Paste the URL from your browser after the OAuth redirect.
                </p>
                <Input
                  placeholder={
                    provider === "codex" || provider === "kiro"
                      ? "http://localhost:1455/auth/callback?code=..."
                      : "http://localhost:1/oauth2callback?code=..."
                  }
                  value={callbackUrl}
                  onChange={(e) => setCallbackUrl(e.target.value)}
                  disabled={isLoading}
                  autoFocus
                />
                {error && <p className="text-sm text-destructive">{error}</p>}
              </div>
              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Connecting...
                  </>
                ) : (
                  <>
                    Connect {providerConfig.name} Account
                  </>
                )}
              </Button>
            </form>
          )}

          {/* Step 3: Paste API key (API key providers only) */}
          {step === 3 && providerConfig && providerConfig.flowType === "api_key" && (
            <form
              onSubmit={handleConnectWithApiKey}
              className="space-y-4"
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore="true"
            >
              <div className="space-y-2">
                <Label className="text-sm font-medium">
                  Connect {providerConfig.name}
                </Label>
                <p className="text-sm text-muted-foreground">
                  Paste your provider API key directly. The key will be stored encrypted.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="provider-api-key" className="text-sm font-medium">
                  API Key
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="provider-api-key"
                    type="text"
                    name="provider-token"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    data-lpignore="true"
                    data-1p-ignore="true"
                    placeholder={providerConfig.apiKeyPlaceholder}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    disabled={isLoading}
                    autoFocus
                    style={
                      isApiKeyVisible
                        ? undefined
                        : ({ WebkitTextSecurity: "disc" } as React.CSSProperties)
                    }
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setIsApiKeyVisible((current) => !current)}
                    disabled={isLoading}
                    className="min-w-16"
                  >
                    {isApiKeyVisible ? "Hide" : "Show"}
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="provider-account-name" className="text-sm font-medium">
                  Account Name (optional)
                </Label>
                <Input
                  id="provider-account-name"
                  name="provider-account-label"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder={providerConfig.accountNamePlaceholder}
                  value={accountName}
                  onChange={(e) => setAccountName(e.target.value)}
                  disabled={isLoading}
                />
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Connecting...
                  </>
                ) : (
                  <>Connect {providerConfig.name} Account</>
                )}
              </Button>
            </form>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          <div>
            {step > 1 && !isPolling && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setStep(step - 1)}
                disabled={isLoading}
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back
              </Button>
            )}
          </div>
          <div>
            {step === 2 && providerConfig && providerConfig.flowType !== "device_code" && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setStep(3)}
              >
                Next
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
