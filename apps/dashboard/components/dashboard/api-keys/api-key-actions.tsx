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
import { EditableApiKeyName } from "./editable-api-key-name";

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
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to toggle API key");
    } finally {
      setIsToggling(false);
    }
  };

  const handleReveal = async () => {
    if (isRevealed) {
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
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to reveal API key");
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!revealedKey) {
      setIsLoading(true);
      try {
        const result = await revealApiKey(apiKey.id);

        if (!result.success) {
          throw new Error(result.error);
        }

        await navigator.clipboard.writeText(result.data.key);
        setCopied(true);
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

      setDialogOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete API key");
    } finally {
      setIsDeleting(false);
    }
  };

  const displayKey = isRevealed && revealedKey
    ? revealedKey
    : `${apiKey.keyPreview.substring(0, 8)}••••••••`;

  return (
    <div className="rounded-xl border border-border/70 bg-muted/20 p-3.5">
      <div className="flex flex-col gap-3">
        <div className="relative">
          <button
            type="button"
            onClick={handleReveal}
            disabled={isLoading}
            className={cn(
              "flex w-full items-center gap-2 rounded-md border border-input bg-input/30 px-3 py-2 text-left font-mono text-xs text-muted-foreground outline-none transition-colors disabled:pointer-events-none disabled:opacity-50",
              isRevealed ? "min-h-9" : "h-9",
            )}
            aria-label={isRevealed ? "Hide API key" : "Show API key"}
            title={isRevealed ? "Hide key" : "Reveal key"}
          >
            <span
              className={cn(
                "min-w-0 flex-1 pr-2",
                isRevealed ? "break-all whitespace-normal" : "truncate whitespace-nowrap"
              )}
            >
              {displayKey}
            </span>
            <span
              className="shrink-0 text-muted-foreground"
              aria-hidden="true"
            >
              {isRevealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </span>
          </button>
        </div>

        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex items-center gap-2">
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9"
                  title="Delete key"
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[400px]">
                <DialogHeader>
                  <DialogTitle>Delete API Key</DialogTitle>
                  <DialogDescription>
                    Are you sure you want to delete &quot;{apiKey.name ?? "Unnamed key"}&quot;? This action cannot be undone.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={handleDelete}
                    disabled={isDeleting}
                  >
                    {isDeleting ? "Deleting..." : "Delete"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9"
              onClick={handleCopy}
              disabled={isLoading}
              title="Copy key"
            >
              {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
            </Button>

            <EditableApiKeyName id={apiKey.id} name={apiKey.name} showTitle={false} />
          </div>

          <div className="flex items-center gap-1.5 shrink-0 self-end">
            <span className="text-[11px] text-muted-foreground">
              {apiKey.isActive ? "On" : "Off"}
            </span>
            <Switch
              checked={apiKey.isActive}
              onCheckedChange={handleToggle}
              disabled={isToggling}
              title={apiKey.isActive ? "Disable key" : "Enable key"}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
