"use client";

import { useState } from "react";
import { Pin, PinOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { togglePinnedProvider } from "@/lib/actions/pinned-providers";
import { toast } from "sonner";
import type { ProviderAccountKey } from "@/lib/provider-accounts";

interface PinButtonProps {
  providerKey: ProviderAccountKey;
  initialPinned: boolean;
}

export function PinButton({ providerKey, initialPinned }: PinButtonProps) {
  const [pinned, setPinned] = useState(initialPinned);

  const handleToggle = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const wasPinned = pinned;
    setPinned(!wasPinned);

    const result = await togglePinnedProvider(providerKey);
    if (!result.success) {
      setPinned(wasPinned);
      toast.error(result.error);
    }
  };

  return (
    <button
      type="button"
      onClick={handleToggle}
      className={cn(
        "p-1 rounded-md transition-colors cursor-pointer",
        pinned
          ? "text-foreground hover:text-muted-foreground"
          : "text-muted-foreground/40 hover:text-muted-foreground"
      )}
      title={pinned ? "Unpin from sidebar" : "Pin to sidebar"}
    >
      {pinned ? <Pin className="h-4 w-4" /> : <PinOff className="h-4 w-4" />}
    </button>
  );
}
