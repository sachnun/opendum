"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Trash2, Eye, EyeOff, Copy, Check } from "lucide-react";
import { toast } from "sonner";
import { revokeApiKey, revealApiKey } from "@/lib/actions/api-keys";

interface ApiKey {
  id: string;
  name: string | null;
  keyPreview: string;
  isActive: boolean;
}

export function ApiKeyActions({ apiKey }: { apiKey: ApiKey }) {
  const [isRevoking, setIsRevoking] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [isRevealed, setIsRevealed] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleReveal = async () => {
    if (isRevealed) {
      // Hide the key
      setIsRevealed(false);
      setRevealedKey(null);
      return;
    }

    setIsLoading(true);
    try {
      const result = await revealApiKey(apiKey.id);

      if (!result.success) {
        throw new Error(result.error);
      }

      setRevealedKey(result.data.key);
      setIsRevealed(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reveal API key");
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!revealedKey) {
      // If key is not revealed, reveal it first
      setIsLoading(true);
      try {
        const result = await revealApiKey(apiKey.id);

        if (!result.success) {
          throw new Error(result.error);
        }

        await navigator.clipboard.writeText(result.data.key);
        setCopied(true);
        toast.success("API key copied to clipboard");
        setTimeout(() => setCopied(false), 2000);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to copy API key");
      } finally {
        setIsLoading(false);
      }
      return;
    }

    try {
      await navigator.clipboard.writeText(revealedKey);
      setCopied(true);
      toast.success("API key copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  };

  const handleRevoke = async () => {
    setIsRevoking(true);
    try {
      const result = await revokeApiKey(apiKey.id);

      if (!result.success) {
        throw new Error(result.error);
      }

      toast.success("API key revoked");
      setDialogOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to revoke API key");
    } finally {
      setIsRevoking(false);
    }
  };

  // Mask the key preview for display
  const displayKey = isRevealed && revealedKey 
    ? revealedKey 
    : apiKey.keyPreview.substring(0, 8) + "••••••••••••••••";

  if (!apiKey.isActive) {
    return (
      <span className="text-sm text-muted-foreground">Revoked</span>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {/* Key display with reveal/copy */}
      <div className="flex items-center gap-1">
        <code className={cn(
          "text-xs bg-muted px-2 py-1 rounded font-mono",
          isRevealed ? "" : "max-w-[200px] truncate"
        )}>
          {displayKey}
        </code>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={handleReveal}
          disabled={isLoading}
          title={isRevealed ? "Hide key" : "Reveal key"}
        >
          {isRevealed ? (
            <EyeOff className="h-3.5 w-3.5" />
          ) : (
            <Eye className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={handleCopy}
          disabled={isLoading}
          title="Copy key"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>

      {/* Revoke dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            <Trash2 className="mr-1 h-3 w-3" />
            Revoke
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke API Key</DialogTitle>
            <DialogDescription>
              Are you sure you want to revoke &quot;{apiKey.name ?? "Unnamed Key"}&quot;? Any applications
              using this key will no longer be able to access the proxy.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleRevoke}
              disabled={isRevoking}
            >
              {isRevoking ? "Revoking..." : "Revoke"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
