import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { ApiKeyAccessPicker } from "~/components/api-key/ApiKeyAccessPicker";
import type { AccessMode } from "~/lib/access-draft";

interface HarnessProps {
  initialMode?: AccessMode;
  initialIds?: string[];
  saved?: { mode: AccessMode; ids: string[] };
  onSave?: (value: { mode: AccessMode; ids: string[] }) => void;
}

function Harness(props: HarnessProps) {
  const [mode, setMode] = createSignal<AccessMode>(props.initialMode ?? "all");
  const [ids, setIds] = createSignal<string[]>(props.initialIds ?? []);

  return (
    <ApiKeyAccessPicker
      mode={mode()}
      onModeChange={setMode}
      ids={ids()}
      onIdsChange={setIds}
      saved={props.saved ?? { mode: props.initialMode ?? "all", ids: props.initialIds ?? [] }}
      isSaving={false}
      error=""
      onSave={props.onSave ?? (() => undefined)}
      title="Models"
      noun="model"
      targets={[
        { id: "gpt-4o", label: "gpt-4o", mono: true },
        { id: "claude-sonnet", label: "claude-sonnet", mono: true },
      ]}
      searchText={(target) => target.label}
      initialMode={props.initialMode ?? "all"}
      initialIds={props.initialIds ?? []}
      normalize={(values) => Array.from(new Set(values)).sort()}
    />
  );
}

const modeButton = (label: string) => screen.getByRole("button", { name: label });
const saveButton = () => screen.getAllByRole("button", { name: "Save" }).at(-1) as HTMLButtonElement;

afterEach(() => cleanup());

describe("ApiKeyAccessPicker", () => {
  test("hides the target picker while mode is all", () => {
    render(() => <Harness />);

    expect(screen.queryByText("Select models")).not.toBeInTheDocument();
  });

  test("shows the picker once whitelist is selected", async () => {
    render(() => <Harness />);

    modeButton("Whitelist").click();

    expect(await screen.findByText("Select models")).toBeInTheDocument();
  });

  test("blocks saving an empty whitelist", async () => {
    const onSave = vi.fn();
    render(() => <Harness initialMode="whitelist" initialIds={["gpt-4o"]} onSave={onSave} />);

    screen.getByText("Clear").click();
    saveButton().click();

    expect(onSave).not.toHaveBeenCalled();
    expect(await screen.findByText("Select at least one model")).toBeInTheDocument();
  });

  test("saves the normalized selection", () => {
    const onSave = vi.fn();
    render(() => (
      <Harness
        initialMode="whitelist"
        initialIds={["claude-sonnet", "gpt-4o"]}
        saved={{ mode: "whitelist", ids: ["gpt-4o"] }}
        onSave={onSave}
      />
    ));

    saveButton().click();

    expect(onSave).toHaveBeenCalledWith({ mode: "whitelist", ids: ["claude-sonnet", "gpt-4o"] });
  });

  test("saves an all-mode switch as an empty list", () => {
    const onSave = vi.fn();
    render(() => (
      <Harness
        initialMode="whitelist"
        initialIds={["gpt-4o"]}
        saved={{ mode: "whitelist", ids: ["gpt-4o"] }}
        onSave={onSave}
      />
    ));

    modeButton("All").click();
    saveButton().click();

    expect(onSave).toHaveBeenCalledWith({ mode: "all", ids: [] });
  });

  test("keeps save disabled when nothing changed", () => {
    render(() => <Harness initialMode="whitelist" initialIds={["gpt-4o"]} />);

    expect(saveButton()).toBeDisabled();
  });

  test("enables save after clearing the selection", () => {
    render(() => <Harness initialMode="whitelist" initialIds={["gpt-4o"]} />);

    expect(saveButton()).toBeDisabled();
    screen.getByText("Clear").click();

    expect(saveButton()).toBeEnabled();
    expect(screen.getByText("No models selected")).toBeInTheDocument();
  });
});
