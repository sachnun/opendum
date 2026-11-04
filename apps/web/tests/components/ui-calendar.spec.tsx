import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { CalendarDate, today, getLocalTimeZone, type DateValue } from "@internationalized/date";
import { createSignal } from "solid-js";
import { UiCalendar } from "~/components/ui/UiCalendar";

function Harness(props: {
  initial?: CalendarDate;
  onPick?: (value: DateValue | undefined) => void;
  disabled?: (date: DateValue) => boolean;
}) {
  const [value, setValue] = createSignal<CalendarDate | undefined>(props.initial);

  return (
    <UiCalendar
      value={value()}
      onValueChange={(next) => {
        setValue(next as CalendarDate | undefined);
        props.onPick?.(next);
      }}
      isDateDisabled={props.disabled}
    />
  );
}

const dayButton = (day: number) => screen.getAllByRole("button", { name: String(day) })[0] as HTMLButtonElement;

afterEach(() => cleanup());

describe("UiCalendar", () => {
  test("renders a full six week grid", () => {
    render(() => <Harness initial={new CalendarDate(2026, 3, 15)} />);

    expect(screen.getAllByRole("row")).toHaveLength(7);
    expect(screen.getAllByRole("columnheader")).toHaveLength(7);
  });

  test("shows the month heading for the selected value", () => {
    render(() => <Harness initial={new CalendarDate(2026, 3, 15)} />);

    expect(screen.getByText(/March 2026/)).toBeInTheDocument();
  });

  test("moves to the previous and next month", () => {
    render(() => <Harness initial={new CalendarDate(2026, 3, 15)} />);

    screen.getByRole("button", { name: "Next month" }).click();
    expect(screen.getByText(/April 2026/)).toBeInTheDocument();

    screen.getByRole("button", { name: "Previous month" }).click();
    screen.getByRole("button", { name: "Previous month" }).click();
    expect(screen.getByText(/February 2026/)).toBeInTheDocument();
  });

  test("reports the picked day", () => {
    const onPick = vi.fn();
    render(() => <Harness initial={new CalendarDate(2026, 3, 15)} onPick={onPick} />);

    dayButton(20).click();

    const picked = onPick.mock.calls[0]?.[0] as CalendarDate;
    expect(picked.year).toBe(2026);
    expect(picked.month).toBe(3);
    expect(picked.day).toBe(20);
  });

  test("disables dates rejected by the guard", () => {
    render(() => <Harness initial={new CalendarDate(2026, 3, 15)} disabled={(date) => (date as CalendarDate).day === 10} />);

    expect(dayButton(10)).toBeDisabled();
    expect(dayButton(11)).toBeEnabled();
  });

  test("highlights today", () => {
    const now = today(getLocalTimeZone());
    render(() => <Harness initial={new CalendarDate(now.year, now.month, 1)} />);

    expect(dayButton(now.day).className).toContain("bg-accent");
  });
});
