import { For, Show, createSignal, type JSX } from "solid-js";
import type { ActionResult } from "~/lib/api-types";
import { COMMON_HEADER_NAMES } from "~/lib/headers";
import { parseUrl, settle } from "~/lib/settle";
import { cn, messageOf } from "~/lib/utils";
import { api } from "~/api";
import { ModelAliasSelect } from "~/components/model/ModelAliasSelect";
import { UiButton } from "~/components/ui/UiButton";
import { UiIcon } from "~/components/ui/UiIcon";
import { UiTooltip } from "~/components/ui/UiTooltip";

interface HeaderRow {
  key: string;
  value: string;
}

interface ModelRow {
  model: string;
  alias: string;
  aliased: boolean;
}

const STEP_COUNT = 2;
const INPUT_CLASS =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50";
const LABEL_CLASS = "text-xs font-medium text-foreground";
const MULTIPART_SUFFIXES = new Set(["ac", "biz", "co", "com", "edu", "go", "gov", "mil", "my", "ne", "net", "or", "org", "sch", "web"]);

export interface CustomProviderSetupProps {
  onCreated: (slug: string) => void;
  onCancel: () => void;
}

export function CustomProviderSetup(props: CustomProviderSetupProps): JSX.Element {
  const [step, setStep] = createSignal(1);
  const [busy, setBusy] = createSignal("");
  const [errorMessage, setErrorMessage] = createSignal("");
  const [providerCreated, setProviderCreated] = createSignal(false);
  const [name, setName] = createSignal("");
  const [baseUrl, setBaseUrl] = createSignal("");
  const [headers, setHeaders] = createSignal<HeaderRow[]>([{ key: "", value: "" }]);
  const [apiKey, setApiKey] = createSignal("");
  const [models, setModels] = createSignal<ModelRow[]>([{ model: "", alias: "", aliased: false }]);
  const [synced, setSynced] = createSignal(false);

  const host = () => {
    const parsed = parseUrl(baseUrl().trim());
    return parsed ? parsed.hostname.toLowerCase().replace(/^www\./, "") : "";
  };

  const domain = () => {
    const labels = host().split(".");
    if (labels.length < 2) return host();
    const suffix = labels[labels.length - 2] ?? "";
    const extension = labels[labels.length - 1] ?? "";
    const suffixLength = labels.length > 2 && extension.length === 2 && MULTIPART_SUFFIXES.has(suffix) ? 2 : 1;
    return labels[labels.length - 1 - suffixLength] ?? "";
  };

  const slug = () =>
    domain()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-{2,}/g, "-")
      .slice(0, 32)
      .replace(/-+$/, "");

  const canCreate = () => name().trim() !== "" && baseUrl().trim() !== "" && /^[a-z]/.test(slug());
  const filledModels = () => models().filter((row) => row.model.trim() !== "");
  const saving = () => busy() === "create" || busy() === "connect" || busy() === "models";

  function updateHeaders(next: HeaderRow[]) {
    for (let index = next.length - 2; index >= 0; index -= 1) {
      const row = next[index];
      if (row && row.key.trim() === "") next.splice(index, 1);
    }
    const last = next[next.length - 1];
    if (!last || last.key.trim() !== "") next.push({ key: "", value: "" });
    setHeaders([...next]);
  }

  function updateModels(next: ModelRow[]) {
    for (let index = next.length - 2; index >= 0; index -= 1) {
      const row = next[index];
      if (row && row.model.trim() === "") next.splice(index, 1);
    }
    const last = next[next.length - 1];
    if (!last || last.model.trim() !== "") next.push({ model: "", alias: "", aliased: false });
    setModels([...next]);
  }

  function setAlias(row: ModelRow, value: string) {
    row.alias = value;
    row.aliased = value !== "";
    setModels([...models()]);
  }

  function run(action: () => Promise<ActionResult<unknown>>, key: string): Promise<boolean> {
    setBusy(key);
    setErrorMessage("");
    return action()
      .then((result) => {
        if (!result.success) {
          setErrorMessage(result.error);
          return false;
        }
        return true;
      })
      .catch((error) => {
        setErrorMessage(messageOf(error));
        return false;
      })
      .finally(() => setBusy(""));
  }

  function headersPayload(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const row of headers()) {
      const key = row.key.trim();
      const value = row.value.trim();
      if (key && value) result[key] = value;
    }
    return result;
  }

  async function ensureProvider(): Promise<boolean> {
    if (providerCreated()) return true;
    const ok = await run(
      () =>
        api.customProviders.create({
          slug: slug(),
          name: name().trim(),
          baseUrl: baseUrl().trim(),
          extraHeaders: headersPayload(),
        }),
      "create"
    );
    if (ok) setProviderCreated(true);
    return ok;
  }

  async function syncModels() {
    setBusy("sync");
    setErrorMessage("");
    const preview = await settle(() =>
      api.customProviders.previewModels({
        baseUrl: baseUrl().trim(),
        extraHeaders: headersPayload(),
        token: apiKey().trim() || undefined,
      })
    );
    setBusy("");
    if (!preview.ok) {
      setErrorMessage(messageOf(preview.error));
      return;
    }
    if (!preview.value.success) {
      setErrorMessage(preview.value.error);
      return;
    }
    const result = preview.value;
    setModels(
      result.data.models.length > 0
        ? result.data.models.map((model) => {
            const source = model.upstream || model.modelId;
            return { model: source, alias: model.modelId === source ? "" : model.modelId, aliased: model.modelId !== source };
          })
        : [{ model: "", alias: "", aliased: false }]
    );
    setSynced(true);
  }

  async function finish() {
    const token = apiKey().trim();
    if (!token) {
      setErrorMessage("API key is required.");
      return;
    }
    if (!(await ensureProvider())) return;
    if (!(await run(() => api.customProviders.connect({ slug: slug(), token }), "connect"))) return;
    const rows = filledModels();
    if (rows.length > 0) {
      const payload = rows.map((row) => ({
        modelId: row.alias.trim() || row.model.trim(),
        upstream: row.model.trim(),
        aliased: row.aliased,
      }));
      if (!(await run(() => api.customProviders.addModels({ slug: slug(), models: payload }), "models"))) return;
    }
    props.onCreated(slug());
  }

  function back() {
    setErrorMessage("");
    if (step() === 1) {
      props.onCancel();
      return;
    }
    setStep(step() - 1);
  }

  function next() {
    setErrorMessage("");
    if (step() === 1) {
      if (!canCreate()) {
        setErrorMessage("Name and a valid base URL are required.");
        return;
      }
      setStep(2);
      return;
    }
    void finish();
  }

  return (
    <div class="flex min-h-0 flex-1 flex-col gap-4">
      <div class="flex items-center justify-center py-2">
        <For each={Array.from({ length: STEP_COUNT }, (_, index) => index + 1)}>
          {(stepNumber) => (
            <div class="flex items-center">
              <div
                class={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium transition-colors",
                  step() >= stepNumber ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                )}
              >
                <Show when={step() > stepNumber} fallback={stepNumber}>
                  <UiIcon name="i-lucide-check" class="size-4" />
                </Show>
              </div>
              <Show when={stepNumber < STEP_COUNT}>
                <div class={cn("h-px w-10 transition-colors", step() > stepNumber ? "bg-primary" : "bg-border")} />
              </Show>
            </div>
          )}
        </For>
      </div>

      <div class="min-h-0 flex-1 space-y-4 overflow-y-auto">
        <Show when={errorMessage()}>
          <div class="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {errorMessage()}
          </div>
        </Show>

        <Show when={step() === 1}>
          <div class="space-y-4">
            <label class="grid gap-1.5">
              <span class={LABEL_CLASS}>
                Name <span aria-hidden="true" class="text-destructive">*</span>
              </span>
              <input
                value={name()}
                class={INPUT_CLASS}
                placeholder="My vLLM"
                onInput={(event) => setName(event.currentTarget.value)}
              />
            </label>
            <label class="grid gap-1.5">
              <span class={LABEL_CLASS}>
                Base URL <span aria-hidden="true" class="text-destructive">*</span>
              </span>
              <input
                value={baseUrl()}
                class={cn(INPUT_CLASS, "font-mono")}
                placeholder="https://vllm.example.com/v1"
                onInput={(event) => setBaseUrl(event.currentTarget.value)}
              />
            </label>
            <div class="grid gap-2">
              <span class={LABEL_CLASS}>Headers</span>
              <For each={headers()}>
                {(header, index) => (
                  <div class="flex items-center gap-2">
                    <input
                      value={header.key}
                      class={cn(INPUT_CLASS, "flex-1")}
                      list="custom-provider-header-names"
                      placeholder="Header"
                      onInput={(event) => {
                        const next = [...headers()];
                        const row = next[index()];
                        if (row) row.key = event.currentTarget.value;
                        updateHeaders(next);
                      }}
                    />
                    <input
                      value={header.value}
                      class={cn(INPUT_CLASS, "flex-1")}
                      placeholder="Value"
                      onInput={(event) => {
                        const next = [...headers()];
                        const row = next[index()];
                        if (row) row.value = event.currentTarget.value;
                        updateHeaders(next);
                      }}
                    />
                  </div>
                )}
              </For>
              <datalist id="custom-provider-header-names">
                <For each={COMMON_HEADER_NAMES}>{(headerName) => <option value={headerName} />}</For>
              </datalist>
            </div>
          </div>
        </Show>

        <Show when={step() === 2}>
          <div class="space-y-3">
            <label class="grid gap-1.5">
              <span class={LABEL_CLASS}>
                API key <span aria-hidden="true" class="text-destructive">*</span>
              </span>
              <input
                value={apiKey()}
                type="password"
                class={cn(INPUT_CLASS, "font-mono")}
                placeholder="sk-..."
                onInput={(event) => setApiKey(event.currentTarget.value)}
              />
            </label>
            <div class="grid gap-2">
              <div class="flex items-center justify-between">
                <span class={LABEL_CLASS}>Models ({filledModels().length})</span>
                <UiTooltip text="Refresh">
                  <UiButton
                    size="icon-sm"
                    variant="outline"
                    disabled={busy() === "sync" || baseUrl().trim() === ""}
                    onClick={() => void syncModels()}
                  >
                    <UiIcon name="i-lucide-refresh-cw" class={cn("size-4", busy() === "sync" && "animate-spin")} />
                  </UiButton>
                </UiTooltip>
              </div>
              <For each={models()}>
                {(row) => (
                  <div class="flex items-center gap-2">
                    <input
                      value={row.model}
                      class={cn(INPUT_CLASS, "flex-1 font-mono")}
                      placeholder="model"
                      onInput={(event) => {
                        row.model = event.currentTarget.value;
                        updateModels([...models()]);
                      }}
                    />
                    <div class="min-w-0 flex-1">
                      <ModelAliasSelect
                        modelValue={row.alias}
                        defaultId={row.model}
                        onValueChange={(value) => setAlias(row, value)}
                      />
                    </div>
                  </div>
                )}
              </For>
              <Show when={synced()}>
                <p class="text-xs text-muted-foreground">Synced {filledModels().length} model(s).</p>
              </Show>
            </div>
          </div>
        </Show>
      </div>

      <div class="flex flex-row items-center justify-between gap-2">
        <UiButton type="button" variant="ghost" disabled={busy() !== ""} onClick={back}>
          <UiIcon name="i-lucide-arrow-left" class="size-4" />
          Back
        </UiButton>
        <UiButton
          type="button"
          variant="ghost"
          class="ml-auto"
          disabled={busy() !== "" || (step() === 1 && !canCreate()) || (step() === 2 && apiKey().trim() === "")}
          onClick={next}
        >
          {step() === 1 ? "Next" : saving() ? "Saving…" : "Finish"}
          <UiIcon name="i-lucide-arrow-right" class="size-4" />
        </UiButton>
      </div>
    </div>
  );
}
