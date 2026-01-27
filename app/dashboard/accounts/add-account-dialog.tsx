"use client";

import { useState } from "react";
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
  Check,
} from "lucide-react";
import { toast } from "sonner";
import { exchangeIflowOAuthCode, exchangeAntigravityOAuthCode } from "@/lib/actions/accounts";
import { cn } from "@/lib/utils";

type Provider = "iflow" | "antigravity" | null;

const PROVIDERS = {
  iflow: {
    name: "iFlow",
    icon: Zap,
    color: "blue",
    description: "Access OpenAI compatible API",
    oauthUrl: "/api/oauth/iflow",
    exchangeAction: exchangeIflowOAuthCode,
  },
  antigravity: {
    name: "Antigravity",
    icon: Sparkles,
    color: "purple",
    description: "Access Gemini & Claude via Google OAuth",
    oauthUrl: "/api/oauth/antigravity",
    exchangeAction: exchangeAntigravityOAuthCode,
  },
} as const;

export function AddAccountDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [provider, setProvider] = useState<Provider>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const resetForm = () => {
    setStep(1);
    setProvider(null);
    setCallbackUrl("");
    setError("");
    setIsLoading(false);
  };

  const handleOpenChange = (isOpen: boolean) => {
    if (!isLoading) {
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
    if (!provider) return;
    window.open(PROVIDERS[provider].oauthUrl, "_blank");
    setStep(3);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!provider) {
      setError("Please select a provider first");
      setStep(1);
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
      const result = await PROVIDERS[provider].exchangeAction(callbackUrl.trim());

      if (!result.success) {
        throw new Error(result.error);
      }

      const message = result.data.isUpdate
        ? `${PROVIDERS[provider].name} account updated successfully!`
        : `${PROVIDERS[provider].name} account connected successfully!`;

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

  const providerConfig = provider ? PROVIDERS[provider] : null;

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
              <div className="grid grid-cols-2 gap-3">
                {(Object.entries(PROVIDERS) as [keyof typeof PROVIDERS, typeof PROVIDERS[keyof typeof PROVIDERS]][]).map(
                  ([key, config]) => {
                    const Icon = config.icon;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => handleSelectProvider(key)}
                        className={cn(
                          "flex flex-col items-center gap-2 rounded-lg border-2 p-4 text-center transition-all hover:border-primary hover:bg-accent",
                          provider === key
                            ? "border-primary bg-accent"
                            : "border-border"
                        )}
                      >
                        <Icon
                          className={cn(
                            "h-8 w-8",
                            config.color === "blue"
                              ? "text-blue-500"
                              : "text-purple-500"
                          )}
                        />
                        <div>
                          <div className="font-medium">{config.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {config.description}
                          </div>
                        </div>
                      </button>
                    );
                  }
                )}
              </div>
            </div>
          )}

          {/* Step 2: OAuth Login */}
          {step === 2 && providerConfig && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label className="text-sm font-medium">
                  Login to {providerConfig.name}
                </Label>
                <p className="text-sm text-muted-foreground">
                  Click the button below to open the login page in a new tab.
                  After logging in, you&apos;ll be redirected to a page that shows
                  an error - this is expected.
                </p>
              </div>
              <Button onClick={handleStartOAuth} variant="outline" className="w-full">
                <ExternalLink className="mr-2 h-4 w-4" />
                Open {providerConfig.name} Login
              </Button>
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription className="text-xs">
                  After login, copy the <strong>entire URL</strong> from your
                  browser&apos;s address bar (it should contain{" "}
                  <code className="rounded bg-muted px-1">code=</code>)
                </AlertDescription>
              </Alert>
            </div>
          )}

          {/* Step 3: Paste URL */}
          {step === 3 && providerConfig && (
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
                    {providerConfig.color === "blue" ? (
                      <Zap className="mr-2 h-4 w-4" />
                    ) : (
                      <Sparkles className="mr-2 h-4 w-4" />
                    )}
                    Connect {providerConfig.name} Account
                  </>
                )}
              </Button>
            </form>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          <div>
            {step > 1 && (
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
            {step === 2 && (
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
