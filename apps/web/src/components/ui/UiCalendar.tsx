import { useState } from "react";
import { addMonths, eachDayOfInterval, endOfMonth, format, isSameDay, isSameMonth, isToday, startOfMonth, startOfWeek, endOfWeek } from "date-fns";
import { cn } from "../../lib/utils";
import { UiIcon } from "./UiIcon";

export interface UiCalendarProps {
  value?: Date | null;
  onChange?: (date: Date | undefined) => void;
  isDateDisabled?: (date: Date) => boolean;
  className?: string;
}

export function UiCalendar({ value, onChange, isDateDisabled, className }: UiCalendarProps) {
  const [month, setMonth] = useState(() => startOfMonth(value ?? new Date()));

  const days = eachDayOfInterval({
    start: startOfWeek(startOfMonth(month), { weekStartsOn: 0 }),
    end: endOfWeek(endOfMonth(month), { weekStartsOn: 0 }),
  });

  return (
    <div className={cn("bg-background group/calendar w-fit rounded-md border border-border p-3 [--cell-size:--spacing(8)]", className)}>
      <div className="relative flex h-(--cell-size) items-center justify-center">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => setMonth((m) => addMonths(m, -1))}
          className="absolute left-0 inline-flex size-(--cell-size) cursor-pointer items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:pointer-events-none disabled:opacity-50"
        >
          <UiIcon name="i-lucide-chevron-left" className="size-4" />
        </button>
        <div className="select-none px-(--cell-size) text-sm font-medium">{format(month, "MMMM yyyy")}</div>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => setMonth((m) => addMonths(m, 1))}
          className="absolute right-0 inline-flex size-(--cell-size) cursor-pointer items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:pointer-events-none disabled:opacity-50"
        >
          <UiIcon name="i-lucide-chevron-right" className="size-4" />
        </button>
      </div>
      <div className="mt-2 grid grid-cols-7 gap-0.5 text-center text-xs text-muted-foreground">
        {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => (
          <div key={day} className="flex h-(--cell-size) items-center justify-center">
            {day}
          </div>
        ))}
      </div>
      <div className="mt-0.5 grid grid-cols-7 gap-0.5">
        {days.map((day) => {
          const disabled = isDateDisabled?.(day) ?? false;
          const selected = value ? isSameDay(day, value) : false;
          return (
            <button
              key={day.toISOString()}
              type="button"
              disabled={disabled}
              onClick={() => onChange?.(day)}
              className={cn(
                "flex h-(--cell-size) items-center justify-center rounded-md text-sm transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:pointer-events-none disabled:opacity-40",
                !isSameMonth(day, month) && "text-muted-foreground/50",
                selected && "bg-primary text-primary-foreground",
                !selected && !disabled && "hover:bg-accent hover:text-accent-foreground",
                !selected && isToday(day) && "text-primary",
              )}
            >
              {format(day, "d")}
            </button>
          );
        })}
      </div>
    </div>
  );
}
