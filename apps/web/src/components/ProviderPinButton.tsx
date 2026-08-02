import { useState } from "react";
import type { ProviderAccountKey, ProviderAccountDefinition } from "../lib/provider-accounts";
import { useDashboardApi } from "../hooks/useDashboardApi";
import { useDashboardDataInvalidation } from "../hooks/useDashboardDataInvalidation";
import { UiIcon } from "./ui/UiIcon";
import { UiTooltip } from "./ui/UiTooltip";
import { cn } from "../lib/utils";

export interface ProviderPinButtonProps {
  providerKey: ProviderAccountKey;
  pinned: boolean;
  readonly?: boolean;
  className?: string;
  onToggled?: (providerKey: ProviderAccountKey, pinned: boolean) => void;
}

export function ProviderPinButton({ providerKey, pinned, readonly, className, onToggled }: ProviderPinButtonProps) {
  const dashboardApi = useDashboardApi();
  const dashboardInvalidation = useDashboardDataInvalidation();
  const [localPinned, setLocalPinned] = useState(pinned);
  const [pending, setPending] = useState(false);

  const togglePin = async (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (readonly) return;
    const previous = localPinned;
    setLocalPinned(!previous);
    setPending(true);
    try {
      const result = await dashboardApi.accounts.togglePinned({ providerKey });
      if (!result.success) throw new Error(result.error);
      setLocalPinned(result.data.pinned);
      dashboardInvalidation.refreshDashboardData([dashboardInvalidation.keys.shellAccounts, dashboardInvalidation.keys.accountsOverview]);
      onToggled?.(providerKey, result.data.pinned);
    } catch {
      setLocalPinned(previous);
    } finally {
      setPending(false);
    }
  };

  const button = (
    <button
      type="button"
      className={cn(
        "cursor-pointer rounded-md p-1 transition-colors disabled:cursor-default disabled:opacity-50",
        localPinned ? "text-foreground hover:text-muted-foreground" : "text-muted-foreground/40 hover:text-muted-foreground",
        className,
      )}
      aria-label={localPinned ? "Unpin provider" : "Pin provider"}
      aria-pressed={localPinned}
      disabled={pending || readonly}
      onClick={(event) => void togglePin(event)}
    >
      <UiIcon name={localPinned ? "i-lucide-pin" : "i-lucide-pin-off"} className="size-4" />
    </button>
  );

  if (readonly) return button;
  return <UiTooltip text={localPinned ? "Unpin" : "Pin"}>{button}</UiTooltip>;
}
