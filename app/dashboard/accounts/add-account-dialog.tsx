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
  Zap,
  Sparkles,
  Terminal,
  Check,
  Copy,
} from "lucide-react";
import { toast } from "sonner";
import {
  exchangeIflowOAuthCode,
  exchangeAntigravityOAuthCode,
  getIflowAuthUrl,
  getAntigravityAuthUrl,
  initiateQwenCodeAuth,
  pollQwenCodeAuth,
} from "@/lib/actions/accounts";
import { cn } from "@/lib/utils";

type Provider = "iflow" | "antigravity" | "qwen_code" | null;

interface OAuthRedirectConfig {
  flowType: "oauth_redirect";
  getAuthUrl: () => Promise<{ success: true; data: { authUrl: string } } | { success: false; error: string }>;
  exchangeAction: (callbackUrl: string) => Promise<{ success: true; data: { email: string; isUpdate: boolean } } | { success: false; error: string }>;
}

interface DeviceCodeConfig {
  flowType: "device_code";
}

interface ProviderConfig {
  name: string;
  icon: typeof Zap;
  color: "blue" | "purple" | "orange";
  description: string;
}

type ProviderFullConfig = ProviderConfig & (OAuthRedirectConfig | DeviceCodeConfig);

const PROVIDERS: Record<Exclude<Provider, null>, ProviderFullConfig> = {
  iflow: {
    name: "iFlow",
    icon: Zap,
    color: "blue",
    description: "Access OpenAI compatible API",
    flowType: "oauth_redirect",
    getAuthUrl: getIflowAuthUrl,
    exchangeAction: exchangeIflowOAuthCode,
  },
  antigravity: {
    name: "Antigravity",
    icon: Sparkles,
    color: "purple",
    description: "Access Gemini & Claude via Google OAuth",
    flowType: "oauth_redirect",
    getAuthUrl: getAntigravityAuthUrl,
    exchangeAction: exchangeAntigravityOAuthCode,
  },
  qwen_code: {
    name: "Qwen Code",
    icon: Terminal,
    color: "orange",
    description: "Access Qwen Coder models",
    flowType: "device_code",
  },
};

const COLOR_CLASSES: Record<ProviderConfig["color"], string> = {
  blue: "text-blue-500",
  purple: "text-purple-500",
  orange: "text-orange-500",
};

export function AddAccountDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [provider, setProvider] = useState<Provider>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  
  // OAuth redirect flow state
  const [authUrl, setAuthUrl] = useState("");
  const [isFetchingUrl, setIsFetchingUrl] = useState(false);
  
  // Device code flow state
  const [deviceCodeInfo, setDeviceCodeInfo] = useState<{
    deviceCode: string;
    verificationUrl: string;
    codeVerifier: string;
  } | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  const providerConfig = provider ? PROVIDERS[provider] : null;

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
      }
    }
  }, [step, provider, providerConfig]);

  const resetForm = useCallback(() => {
    setStep(1);
    setProvider(null);
    setCallbackUrl("");
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
      "qwen_auth_popup",
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
          deviceCodeInfo.codeVerifier
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
          setError(result.data.message);
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
      await navigator.clipboard.writeText(urlToCopy);
      toast.success("Link copied to clipboard");
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

  const renderProviderIcon = (config: ProviderConfig, className?: string) => {
    const Icon = config.icon;
    return <Icon className={cn(className, COLOR_CLASSES[config.color])} />;
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button className="gap-2">
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
              <Label className="text-sm font-medium">Choose a provider</Label>
              <div className="grid grid-cols-3 gap-3">
                {(Object.entries(PROVIDERS) as [Exclude<Provider, null>, ProviderFullConfig][]).map(
                  ([key, config]) => (
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
                      {renderProviderIcon(config, "h-6 w-6")}
                      <div>
                        <div className="text-sm font-medium">{config.name}</div>
                        <div className="text-[10px] text-muted-foreground leading-tight">
                          {config.description}
                        </div>
                      </div>
                    </button>
                  )
                )}
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
                      <code className="rounded bg-muted px-1">localhost:11451/...?code=...</code>
                    </AlertDescription>
                  </Alert>
                </>
              ) : (
                // Device Code Flow
                <>
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">
                      Login to {providerConfig.name}
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      Click the button below to open the Qwen login page. After you
                      complete the login, authorization will be detected automatically.
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
                  placeholder="http://localhost:11451/oauth2callback?code=..."
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
                    {renderProviderIcon(providerConfig, "mr-2 h-4 w-4")}
                    Connect {providerConfig.name} Account
                  </>
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
            {step === 2 && providerConfig?.flowType === "oauth_redirect" && (
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
