"use client";

import { useState } from "react";
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
import { Pencil } from "lucide-react";
import { toast } from "sonner";
import { updateApiKeyName } from "@/lib/actions/api-keys";

interface EditableApiKeyNameProps {
  id: string;
  name: string | null;
  showTitle?: boolean;
  showEditButton?: boolean;
}

export function EditableApiKeyName({
  id,
  name,
  showTitle = true,
  showEditButton = true,
}: EditableApiKeyNameProps) {
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [newName, setNewName] = useState(name ?? "");
  const [isUpdating, setIsUpdating] = useState(false);

  const handleUpdateName = async () => {
    setIsUpdating(true);
    try {
      const result = await updateApiKeyName(id, newName);

      if (!result.success) {
        throw new Error(result.error);
      }

      setEditDialogOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update API key name");
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <Dialog
      open={editDialogOpen}
      onOpenChange={(open) => {
        setEditDialogOpen(open);
        if (open) setNewName(name ?? "");
      }}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {showTitle && (
          <span className="min-w-0 truncate text-lg font-semibold">{name ?? "Unnamed key"}</span>
        )}
        {showEditButton && (
          <DialogTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9 text-muted-foreground/80 hover:text-foreground"
              title="Edit name"
              aria-label="Edit name"
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          </DialogTrigger>
        )}
      </div>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Edit API Key Name</DialogTitle>
          <DialogDescription className="sr-only">
            Change the name of your API key.
          </DialogDescription>
        </DialogHeader>
        <div className="py-3">
          <Label htmlFor="apiKeyName">Name</Label>
          <Input
            id="apiKeyName"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="My API Key"
            className="mt-1.5"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleUpdateName();
              }
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setEditDialogOpen(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleUpdateName}
            disabled={isUpdating}
          >
            {isUpdating ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
