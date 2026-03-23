import { cn } from "@/lib/utils";
import { type ProviderAccountIndicator } from "@/lib/navigation";

function getAccountIndicatorClass(indicator: ProviderAccountIndicator): string {
  if (indicator === "error") {
    return "bg-red-500";
  }

  if (indicator === "warning") {
    return "bg-yellow-500";
  }

  return "bg-primary";
}

interface AccountStatusIndicatorProps {
  activeAccountCount: number | undefined;
  indicator: ProviderAccountIndicator | undefined;
}

export function AccountStatusIndicator({
  activeAccountCount,
  indicator,
}: AccountStatusIndicatorProps) {
  const hasActiveAccounts =
    typeof activeAccountCount === "number" && activeAccountCount > 0;

  if (hasActiveAccounts && indicator) {
    return (
      <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
            getAccountIndicatorClass(indicator)
          )}
        />
        <span
          className={cn(
            "relative inline-flex h-2.5 w-2.5 rounded-full",
            getAccountIndicatorClass(indicator)
          )}
        />
      </span>
    );
  }

  return (
    <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />
    </span>
  );
}
