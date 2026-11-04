import type { JSX } from "solid-js";
import type { ProviderAccountIndicator } from "~/lib/navigation";

export interface AccountStatusIndicatorProps {
  accountCount?: number;
  activeAccountCount?: number;
  indicator?: ProviderAccountIndicator;
}

export function AccountStatusIndicator(props: AccountStatusIndicatorProps): JSX.Element {
  const hasActiveAccounts = () => typeof props.activeAccountCount === "number" && props.activeAccountCount > 0;
  const indicatorClass = () => {
    if (props.indicator === "error") return "bg-red-500";
    if (props.indicator === "warning") return "bg-yellow-500";
    return "bg-primary";
  };

  return (
    <>
      {hasActiveAccounts() && props.indicator ? (
        <span class="relative flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
          <span class={`absolute inset-0 inline-flex h-full w-full animate-ping rounded-full opacity-75 ${indicatorClass()}`} />
          <span class={`relative inline-flex h-2.5 w-2.5 rounded-full ${indicatorClass()}`} />
        </span>
      ) : (
        <span class="relative flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
          <span class="relative inline-flex h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />
        </span>
      )}
    </>
  );
}
