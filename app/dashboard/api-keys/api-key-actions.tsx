"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
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
import { deleteApiKey, toggleApiKey, revealApiKey } from "@/lib/actions/api-keys";

interface ApiKey {
  id: string;
  name: string | null;
  keyPreview: string;
  isActive: boolean;
}

export function ApiKeyActions({ apiKey }: { apiKey: ApiKey }) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [isToggling, setIsToggling] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [isRevealed, setIsRevealed] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleToggle = async () => {
    setIsToggling(true);
    try {
      const result = await toggleApiKey(apiKey.id);

      if (!result.success) {
        throw new Error(result.error);
      }

      toast.success(apiKey.isActive ? "API key disabled" : "API key enabled");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to toggle API key");
    } finally {
      setIsToggling(false);
    }
  };

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

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      const result = await deleteApiKey(apiKey.id);

      if (!result.success) {
        throw new Error(result.error);
      }

      toast.success("API key deleted");
      setDialogOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete API key");
    } finally {
      setIsDeleting(false);
    }
  };

  // Mask the key preview for display
  const displayKey = isRevealed && revealedKey 
    ? revealedKey 
    : apiKey.keyPreview.substring(0, 8) + "••••••••";

  return (
    <div className="flex items-center gap-2">
      {/* Key display with reveal/copy */}
      <div className="flex items-center gap-1">
        <code className={cn(
          "text-xs bg-muted px-2 py-1 rounded font-mono",
          isRevealed ? "" : "max-w-[160px] truncate"
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

      {/* Enable/Disable toggle */}
      <Switch
        checked={apiKey.isActive}
        onCheckedChange={handleToggle}
        disabled={isToggling}
        title={apiKey.isActive ? "Disable key" : "Enable key"}
      />

      {/* Delete dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete API Key</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &quot;{apiKey.name ?? "Unnamed Key"}&quot;? This action
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isDeleting}
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
