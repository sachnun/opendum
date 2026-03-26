"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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
import { Plus, Copy, Check } from "lucide-react";
import { toast } from "sonner";
import { createApiKey } from "@/lib/actions/api-keys";

export function CreateApiKeyButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleCreate = async () => {
    setIsCreating(true);
    try {
      const result = await createApiKey(
        name.trim() || undefined
      );

      if (!result.success) {
        throw new Error(result.error);
      }

      // Show the created key in the modal
      setCreatedKey(result.data.key);
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
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  };

  const handleClose = () => {
    setOpen(false);
    setName("");
    setCreatedKey(null);
    setCopied(false);
    // Refresh the page to show the new key in the list
    router.refresh();
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => {
      if (!isOpen) {
        handleClose();
      } else {
        setOpen(true);
      }
    }}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Create API Key
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[440px]">
        {createdKey ? (
          <>
            <DialogHeader>
              <DialogTitle>API Key Created</DialogTitle>
              <DialogDescription className="sr-only">
                Your new API key is ready to use.
              </DialogDescription>
            </DialogHeader>
            <div className="py-3">
              <Label>Your API Key</Label>
              <div className="mt-1.5 flex items-center gap-2">
                <code className="flex-1 rounded bg-muted px-2.5 py-1.5 text-xs font-mono break-all">
                  {createdKey}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 w-8 p-0 shrink-0"
                  onClick={handleCopy}
                  title="Copy key"
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5 text-green-500" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                You can reveal and copy this key anytime from the list.
              </p>
            </div>
            <DialogFooter>
              <Button size="sm" onClick={handleClose}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create API Key</DialogTitle>
              <DialogDescription className="sr-only">
                Create a new API key for accessing Opendum.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-3">
              <div>
                <Label htmlFor="keyName">Name (optional)</Label>
                <Input
                  id="keyName"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1.5"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleCreate();
                    }
                  }}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleCreate} disabled={isCreating}>
                {isCreating ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
