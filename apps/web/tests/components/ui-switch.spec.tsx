import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { UiSwitch } from "~/components/ui/UiSwitch";

function Harness(props: { initial?: boolean; disabled?: boolean }) {
  const [checked, setChecked] = createSignal(props.initial ?? false);

  return <UiSwitch checked={checked()} disabled={props.disabled} onCheckedChange={setChecked} title={props.disabled ? "Enable" : undefined} />;
}

const input = () => screen.getByRole("checkbox") as HTMLInputElement;

afterEach(() => cleanup());

describe("UiSwitch", () => {
  test("reflects the unchecked state", () => {
    render(() => <Harness initial={false} />);

    expect(input()).not.toBeChecked();
  });

  test("reflects the checked state", () => {
    render(() => <Harness initial />);

    expect(input()).toBeChecked();
  });

  test("marks the control as disabled", () => {
    render(() => <Harness disabled />);

    expect(input()).toBeDisabled();
  });

  test("keeps the control enabled by default", () => {
    render(() => <Harness />);

    expect(input()).toBeEnabled();
  });

  test("applies the requested size", () => {
    render(() => <UiSwitch checked={false} size="sm" onCheckedChange={() => undefined} />);

    expect(screen.getByRole("checkbox").closest("[data-scope=switch]")).toHaveAttribute("data-size", "sm");
  });
});
