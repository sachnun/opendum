"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
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
import { Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { deleteProviderAccount, updateProviderAccount } from "@/lib/actions/accounts";

interface Account {
  id: string;
  name: string;
  email: string | null;
  isActive: boolean;
}

export function AccountActions({ account }: { account: Account }) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isToggling, setIsToggling] = useState(false);
  const [editName, setEditName] = useState(account.name);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const handleToggleActive = async () => {
    setIsToggling(true);
    try {
      const result = await updateProviderAccount(account.id, { isActive: !account.isActive });

      if (!result.success) {
        throw new Error(result.error);
      }

      toast.success(`Account ${account.isActive ? "disabled" : "enabled"}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update account");
    } finally {
      setIsToggling(false);
    }
  };

  const handleRename = async () => {
    if (!editName.trim()) {
      toast.error("Please enter a name");
      return;
    }

    setIsEditing(true);
    try {
      const result = await updateProviderAccount(account.id, { name: editName.trim() });

      if (!result.success) {
        throw new Error(result.error);
      }

      toast.success("Account renamed");
      setEditDialogOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to rename account");
    } finally {
      setIsEditing(false);
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      const result = await deleteProviderAccount(account.id);

      if (!result.success) {
        throw new Error(result.error);
      }

      toast.success("Account deleted");
      setDeleteDialogOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete account");
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Switch
        checked={account.isActive}
        onCheckedChange={handleToggleActive}
        disabled={isToggling}
        title={account.isActive ? "Disable account" : "Enable account"}
      />

      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            <Pencil className="h-3 w-3" />
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Account</DialogTitle>
            <DialogDescription>
              Enter a new name for this account.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className="mt-2"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleRename();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleRename} disabled={isEditing}>
              {isEditing ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            <Trash2 className="h-3 w-3 text-destructive" />
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Account</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &quot;{account.name}&quot;? This action
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
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
