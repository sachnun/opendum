"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, ExternalLink, AlertCircle, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { exchangeAntigravityOAuthCode } from "@/lib/actions/accounts";

export function AddAntigravityForm() {
  const router = useRouter();
  const [callbackUrl, setCallbackUrl] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!callbackUrl.trim()) {
      setError("Please paste the callback URL");
      return;
    }

    // Basic validation
    if (!callbackUrl.includes("code=")) {
      setError("Invalid URL. Make sure the URL contains 'code=' parameter.");
      return;
    }

    setIsLoading(true);

    try {
      const result = await exchangeAntigravityOAuthCode(callbackUrl.trim());

      if (!result.success) {
        throw new Error(result.error);
      }

      const message = result.data.isUpdate 
        ? "Account updated successfully!" 
        : "Account connected successfully!";
      
      toast.success(message);
      setCallbackUrl("");
      router.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to connect account";
      setError(message);
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleStartOAuth = () => {
    // Open Google OAuth in new tab
    window.open("/api/oauth/antigravity", "_blank");
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-purple-500" />
          Add Antigravity Account
        </CardTitle>
        <CardDescription>
          Connect your Google account to access Gemini and Claude models via Antigravity
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Step 1 */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">Step 1: Login with Google</Label>
          <p className="text-sm text-muted-foreground">
            Click the button below to open Google login page in a new tab.
          </p>
          <Button onClick={handleStartOAuth} variant="outline" className="w-full">
            <ExternalLink className="mr-2 h-4 w-4" />
            Open Google Login
          </Button>
        </div>

        {/* Step 2 */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">Step 2: Copy the callback URL</Label>
          <p className="text-sm text-muted-foreground">
            After logging in, your browser will show an error page (connection refused). 
            This is expected! Copy the <strong>entire URL</strong> from your browser&apos;s address bar.
          </p>
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              The URL should look like: <code className="bg-muted px-1 rounded">http://localhost:11451/oauth2callback?code=...</code>
            </AlertDescription>
          </Alert>
        </div>

        {/* Step 3 */}
        <form onSubmit={handleSubmit} className="space-y-3">
          <Label className="text-sm font-medium">Step 3: Paste URL and connect</Label>
          <Input
            placeholder="http://localhost:11451/oauth2callback?code=..."
            value={callbackUrl}
            onChange={(e) => setCallbackUrl(e.target.value)}
            disabled={isLoading}
          />
          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
          <Button type="submit" className="w-full" disabled={isLoading}>
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Connecting...
              </>
            ) : (
              <>
                <Sparkles className="mr-2 h-4 w-4" />
                Connect Account
              </>
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
