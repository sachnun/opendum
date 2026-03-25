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
}

export function EditableApiKeyName({ id, name }: EditableApiKeyNameProps) {
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

      toast.success("API key name updated");
      setEditDialogOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update API key name");
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className="min-w-0 truncate text-sm font-semibold">{name ?? "Unnamed Key"}</span>
      <Dialog open={editDialogOpen} onOpenChange={(open) => {
        setEditDialogOpen(open);
        if (open) setNewName(name ?? "");
      }}>
        <DialogTrigger asChild>
          <Button 
            variant="ghost" 
            size="sm" 
            className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground" 
            title="Edit name"
          >
            <Pencil className="h-3 w-3" />
          </Button>
        </DialogTrigger>
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
    </div>
  );
}
