"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Plus, Copy, Check, CalendarIcon, X } from "lucide-react";
import { toast } from "sonner";
import { createApiKey } from "@/lib/actions/api-keys";
import { cn } from "@/lib/utils";

export function CreateApiKeyButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState<Date | undefined>(undefined);
  const [isCreating, setIsCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleCreate = async () => {
    setIsCreating(true);
    try {
      const result = await createApiKey(
        name.trim() || undefined,
        expiresAt ?? null
      );

      if (!result.success) {
        throw new Error(result.error);
      }

      // Show the created key in the modal
      setCreatedKey(result.data.key);
      toast.success("API key created!");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create API key");
    } finally {
      setIsCreating(false);
    }
  };

  const handleCopy = async () => {
    if (!createdKey) return;

    try {
      await navigator.clipboard.writeText(createdKey);
      setCopied(true);
      toast.success("API key copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  };

  const handleClose = () => {
    setOpen(false);
    setName("");
    setExpiresAt(undefined);
    setCreatedKey(null);
    setCopied(false);
    // Refresh the page to show the new key in the list
    router.refresh();
  };

  // Minimum date is tomorrow
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => {
      if (!isOpen) {
        handleClose();
      } else {
        setOpen(true);
      }
    }}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          Create API Key
        </Button>
      </DialogTrigger>
      <DialogContent>
        {createdKey ? (
          // Success state - show the created key
          <>
            <DialogHeader>
              <DialogTitle>API Key Created!</DialogTitle>
              <DialogDescription>
                Your new API key is ready to use.
              </DialogDescription>
            </DialogHeader>
            <div className="py-4">
              <Label>Your API Key</Label>
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 rounded bg-muted px-3 py-2 text-sm font-mono break-all">
                  {createdKey}
                </code>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleCopy}
                  title="Copy key"
                >
                  {copied ? (
                    <Check className="h-4 w-4 text-green-500" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                You can reveal and copy this key anytime from the list.
              </p>
            </div>
            <DialogFooter>
              <Button onClick={handleClose}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          // Create state - input name and expiration
          <>
            <DialogHeader>
              <DialogTitle>Create API Key</DialogTitle>
              <DialogDescription>
                Create a new API key for accessing Opendum.
              </DialogDescription>
            </DialogHeader>
            <div className="py-4 space-y-4">
              <div>
                <Label htmlFor="keyName">Name (optional)</Label>
                <Input
                  id="keyName"
                  placeholder="e.g., MacBook Pro, Work PC"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-2"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleCreate();
                    }
                  }}
                />
              </div>
              <div>
                <Label>Expiration (optional)</Label>
                <div className="mt-2 flex items-center gap-2">
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        className={cn(
                          "w-full justify-start text-left font-normal",
                          !expiresAt && "text-muted-foreground"
                        )}
                      >
                        <CalendarIcon className="mr-2 h-4 w-4" />
                        {expiresAt ? format(expiresAt, "PPP") : "No expiration"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={expiresAt}
                        onSelect={setExpiresAt}
                        disabled={(date) => date < tomorrow}
                        initialFocus
                      />
                    </PopoverContent>
                  </Popover>
                  {expiresAt && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setExpiresAt(undefined)}
                      title="Clear expiration"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Leave empty for a key that never expires.
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreate} disabled={isCreating}>
                {isCreating ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
