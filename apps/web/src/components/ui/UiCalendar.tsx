import { CalendarDate, getLocalTimeZone, startOfMonth, startOfWeek, today, type DateValue } from "@internationalized/date";
import { createMemo, createSignal, For, type JSX } from "solid-js";
import { cn } from "~/lib/utils";
import { UiIcon } from "~/components/ui/UiIcon";

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export interface UiCalendarProps {
  value?: DateValue;
  onValueChange: (value: DateValue | undefined) => void;
  isDateDisabled?: (date: DateValue) => boolean;
  class?: string | string[];
}

function monthGrid(month: CalendarDate): DateValue[][] {
  let cursor: DateValue = startOfWeek(startOfMonth(month), "en-US");
  const weeks: DateValue[][] = [];

  for (let week = 0; week < 6; week += 1) {
    const row: DateValue[] = [];
    for (let day = 0; day < 7; day += 1) {
      row.push(cursor);
      cursor = cursor.add({ days: 1 });
    }
    weeks.push(row);
  }

  return weeks;
}

export function UiCalendar(props: UiCalendarProps): JSX.Element {
  const initial = () => props.value ?? today(getLocalTimeZone());
  const [visibleMonth, setVisibleMonth] = createSignal(new CalendarDate(initial().year, initial().month, 1));

  const grid = createMemo(() => monthGrid(visibleMonth()));
  const heading = createMemo(() =>
    visibleMonth().toDate(getLocalTimeZone()).toLocaleDateString(undefined, { month: "long", year: "numeric" })
  );

  const shiftMonth = (delta: number) => {
    const next = visibleMonth().add({ months: delta });
    setVisibleMonth(new CalendarDate(next.year, next.month, 1));
  };

  const isSelected = (date: DateValue) => props.value?.compare(date) === 0;
  const isToday = (date: DateValue) => date.compare(today(getLocalTimeZone())) === 0;

  return (
    <div class={cn("bg-background group/calendar w-fit rounded-md border border-border p-3 [--cell-size:--spacing(8)]", props.class)}>
      <div class="relative flex h-(--cell-size) items-center justify-center">
        <button
          type="button"
          aria-label="Previous month"
          class="absolute left-0 inline-flex size-(--cell-size) cursor-pointer items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          onClick={() => shiftMonth(-1)}
        >
          <UiIcon name="i-lucide-chevron-left" class="size-4" />
        </button>
        <span class="select-none px-(--cell-size) text-sm font-medium">{heading()}</span>
        <button
          type="button"
          aria-label="Next month"
          class="absolute right-0 inline-flex size-(--cell-size) cursor-pointer items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          onClick={() => shiftMonth(1)}
        >
          <UiIcon name="i-lucide-chevron-right" class="size-4" />
        </button>
      </div>

      <table class="mt-4 w-full border-collapse">
        <thead>
          <tr class="flex">
            <For each={WEEKDAYS}>
              {(day) => (
                <th class="flex-1 select-none rounded-md text-center text-[0.8rem] font-normal text-muted-foreground">{day}</th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={grid()}>
            {(week) => (
              <tr class="mt-2 flex w-full">
                <For each={week}>
                  {(date) => {
                    const outside = () => date.month !== visibleMonth().month;
                    const disabled = () => props.isDateDisabled?.(date) ?? false;
                    return (
                      <td class="relative aspect-square h-full w-full p-0 text-center select-none">
                        <button
                          type="button"
                          disabled={disabled()}
                          class={cn(
                            "flex aspect-square size-auto min-w-(--cell-size) cursor-pointer items-center justify-center rounded-md text-sm leading-none font-normal transition-colors outline-none hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:pointer-events-none disabled:opacity-50",
                            isSelected(date) && "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground",
                            !isSelected(date) && isToday(date) && "bg-accent text-accent-foreground",
                            outside() && "text-muted-foreground opacity-50"
                          )}
                          onClick={() => props.onValueChange(date)}
                        >
                          {date.day}
                        </button>
                      </td>
                    );
                  }}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}
