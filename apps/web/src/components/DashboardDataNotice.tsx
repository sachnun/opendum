import { UiIcon } from "./ui/UiIcon";

export function DashboardDataNotice({ error }: { error?: Error | null }) {
  if (!error) return null;
  return (
    <div className="relative w-full rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground" role="alert">
      <div className="flex gap-3">
        <UiIcon name="i-lucide-triangle-alert" className="mt-0.5 size-4 shrink-0 text-yellow-500" />
        <div>
          <p className="font-medium text-foreground">Unable to load live data</p>
          <p className="mt-1 text-muted-foreground">{error.message}</p>
        </div>
      </div>
    </div>
  );
}
