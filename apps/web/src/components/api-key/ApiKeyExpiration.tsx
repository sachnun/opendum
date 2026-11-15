import { Show, createMemo, createSignal, type JSX } from "solid-js";
import { CalendarDate, type DateValue } from "@internationalized/date";
import { format, isSameDay } from "date-fns";
import { api } from "~/api";
import { errorText, settle } from "~/lib/settle";
import { UiButton } from "~/components/ui/UiButton";
import { UiCalendar } from "~/components/ui/UiCalendar";
import { UiIcon } from "~/components/ui/UiIcon";
import { UiPopover } from "~/components/ui/UiPopover";
import { asButtonProps } from "~/components/ui/trigger";

export interface ApiKeyExpirationProps {
  apiKeyId: string;
  initialExpiresAt: string | Date | null;
  readonly?: boolean;
  onUpdated: (value: { expiresAt: string | Date | null }) => void;
}

function calendarDate(value: Date | null): DateValue | undefined {
  if (!value) return undefined;
  return new CalendarDate(value.getFullYear(), value.getMonth() + 1, value.getDate());
}

function dateOnly(value: DateValue): string {
  return value.toString().slice(0, 10);
}

function localDate(value: DateValue | undefined): Date | null {
  if (!value) return null;
  const [year, month, day] = dateOnly(value).split("-").map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

function stamp(dateValue: DateValue | undefined, hour: number, minute: number): Date | null {
  const date = localDate(dateValue);
  if (!date) return null;
  date.setHours(hour, minute, 0, 0);
  return date;
}

export function ApiKeyExpiration(props: ApiKeyExpirationProps): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [isSaving, setIsSaving] = createSignal(false);
  const [expiresAt, setExpiresAt] = createSignal<Date | null>(
    props.initialExpiresAt ? new Date(props.initialExpiresAt) : null
  );
  const [draftDate, setDraftDate] = createSignal<DateValue | undefined>(calendarDate(expiresAt()));
  const [draftHour, setDraftHour] = createSignal(expiresAt()?.getHours() ?? 23);
  const [draftMinute, setDraftMinute] = createSignal(expiresAt()?.getMinutes() ?? 59);
  const [errorMessage, setErrorMessage] = createSignal("");

  function syncDraft() {
    const value = expiresAt();
    setDraftDate(calendarDate(value));
    setDraftHour(value ? value.getHours() : 23);
    setDraftMinute(value ? value.getMinutes() : 59);
    setErrorMessage("");
  }

  function handleOpenChange(value: boolean) {
    setOpen(value);
    if (value) syncDraft();
  }

  const isExpired = () => {
    const value = expiresAt();
    return value != null && value < new Date();
  };
  const displayText = () => {
    const value = expiresAt();
    return value ? format(value, "MMM d, yyyy HH:mm") : "No expiry";
  };
  const draftExpiresAt = createMemo(() => stamp(draftDate(), draftHour(), draftMinute()));
  const draftInPast = createMemo(() => {
    const value = draftExpiresAt();
    return value ? value <= new Date() : false;
  });

  function pastDate(value: DateValue): boolean {
    return dateOnly(value) < format(new Date(), "yyyy-MM-dd");
  }

  function saveDraft() {
    const value = draftExpiresAt();
    if (!value) return;

    if (value <= new Date()) {
      setErrorMessage(isSameDay(value, new Date()) ? "Choose a future time." : "Choose a future expiration.");
      return;
    }

    void saveExpiration(value);
  }

  async function saveExpiration(value: Date | null) {
    if (props.readonly) return;
    setIsSaving(true);
    setErrorMessage("");
    const updated = await settle(() => api.apiKeys.updateExpiration({ id: props.apiKeyId, expiresAt: value }));
    setIsSaving(false);
    if (!updated.ok) {
      setErrorMessage(errorText(updated.error, "Failed to update expiration"));
      return;
    }
    if (!updated.value.success) {
      setErrorMessage(updated.value.error);
      return;
    }
    const result = updated.value;
    setExpiresAt(result.data.expiresAt ? new Date(result.data.expiresAt) : null);
    setOpen(false);
    props.onUpdated({ expiresAt: result.data.expiresAt });
  }

  const timeInputClass =
    "w-12 rounded-md border border-input bg-background px-1.5 py-1 text-center text-sm tabular-nums outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

  return (
    <UiPopover
      open={open()}
      onOpenChange={handleOpenChange}
      align="start"
      contentClass="w-72 p-0"
      trigger={(triggerProps) => (
        <button
          {...asButtonProps(triggerProps)}
          type="button"
          class={`inline-flex cursor-pointer items-center gap-1 text-sm transition-colors hover:text-primary disabled:cursor-default disabled:pointer-events-none disabled:opacity-50 ${
            isExpired() ? "text-destructive" : "text-muted-foreground"
          }`}
          disabled={isSaving() || props.readonly}
        >
          <UiIcon name="i-lucide-calendar" class="size-3" />
          <span>{displayText()}</span>
        </button>
      )}
      content={
        <div class="space-y-3 p-3">
          <div class="space-y-1.5">
            <p class="text-xs font-medium text-muted-foreground">Expiration date</p>
            <UiCalendar value={draftDate()} onValueChange={setDraftDate} isDateDisabled={pastDate} class="border-0 p-0" />
          </div>
          <div class="space-y-1.5">
            <p class="text-xs font-medium text-muted-foreground">Expiration time</p>
            <div class="inline-flex h-9 items-center gap-1 rounded-md border border-input bg-background px-3 text-sm outline-none focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
              <input
                type="number"
                min="0"
                max="23"
                value={String(draftHour()).padStart(2, "0")}
                class={timeInputClass}
                onInput={(event) => {
                  const parsed = Number.parseInt(event.currentTarget.value, 10);
                  if (Number.isFinite(parsed)) setDraftHour(Math.max(0, Math.min(23, parsed)));
                }}
              />
              <span class="text-muted-foreground">:</span>
              <input
                type="number"
                min="0"
                max="59"
                value={String(draftMinute()).padStart(2, "0")}
                class={timeInputClass}
                onInput={(event) => {
                  const parsed = Number.parseInt(event.currentTarget.value, 10);
                  if (Number.isFinite(parsed)) setDraftMinute(Math.max(0, Math.min(59, parsed)));
                }}
              />
            </div>
          </div>
          <Show when={errorMessage()}>
            <p class="text-xs text-destructive">{errorMessage()}</p>
          </Show>
          <div class="flex items-center justify-between gap-2 border-t pt-2">
            <UiButton
              variant="ghost"
              size="sm"
              class="h-7 gap-1 text-xs"
              disabled={isSaving() || !expiresAt()}
              onClick={() => void saveExpiration(null)}
            >
              <UiIcon name="i-lucide-x" class="size-3" />
              Remove expiration
            </UiButton>
            <UiButton
              size="sm"
              class="h-7 text-xs"
              disabled={isSaving() || !draftDate() || draftInPast()}
              onClick={saveDraft}
            >
              Save
            </UiButton>
          </div>
        </div>
      }
    />
  );
}
