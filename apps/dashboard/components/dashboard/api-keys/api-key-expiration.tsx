"use client";

import { useState } from "react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { CalendarIcon, X } from "lucide-react";
import { toast } from "sonner";
import { updateApiKeyExpiration } from "@/lib/actions/api-keys";
import { cn } from "@/lib/utils";

interface ApiKeyExpirationProps {
  apiKeyId: string;
  initialExpiresAt: Date | null;
}

export function ApiKeyExpiration({
  apiKeyId,
  initialExpiresAt,
}: ApiKeyExpirationProps) {
  const [expiresAt, setExpiresAt] = useState<Date | null>(initialExpiresAt);
  const [open, setOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const now = new Date();
  const isExpired = expiresAt != null && expiresAt < now;

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);

  const handleSelect = async (date: Date | undefined) => {
    const newDate = date ?? null;
    setIsSaving(true);
    try {
      const result = await updateApiKeyExpiration(apiKeyId, newDate);
      if (!result.success) {
        throw new Error(result.error);
      }
      setExpiresAt(result.data.expiresAt);
      setOpen(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to update expiration"
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleClearExpiry = async () => {
    setIsSaving(true);
    try {
      const result = await updateApiKeyExpiration(apiKeyId, null);
      if (!result.success) {
        throw new Error(result.error);
      }
      setExpiresAt(null);
      setOpen(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to update expiration"
      );
    } finally {
      setIsSaving(false);
    }
  };

  const displayText = expiresAt
    ? `Exp ${format(expiresAt, "MMM d, yyyy")}`
    : "No expiry";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1 text-xs transition-colors cursor-pointer hover:text-primary",
            isExpired
              ? "text-destructive"
              : "text-muted-foreground"
          )}
          disabled={isSaving}
        >
          <CalendarIcon className="h-3 w-3" />
          <span>{displayText}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <div className="p-2 space-y-2">
          <Calendar
            mode="single"
            selected={expiresAt ?? undefined}
            onSelect={handleSelect}
            disabled={(date) => date < tomorrow || isSaving}
            initialFocus
          />
          {expiresAt && (
            <div className="flex justify-center border-t pt-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs gap-1"
                onClick={handleClearExpiry}
                disabled={isSaving}
              >
                <X className="h-3 w-3" />
                Remove expiration
              </Button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
