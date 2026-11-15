import { createMemo, createSignal, type JSX } from "solid-js";
import { compareIds } from "@opendum/models/sort";
import type { AccessMode } from "~/lib/access-draft";
import { api } from "~/api";
import { errorText, settle } from "~/lib/settle";
import { ApiKeyAccessPicker, type AccessDraft, type AccessTarget } from "~/components/api-key/ApiKeyAccessPicker";

export interface ApiKeyModelAccessProps {
  apiKeyId: string;
  availableModels: string[];
  initialMode: AccessMode;
  initialModels: string[];
  readonly?: boolean;
  onUpdated: (value: { mode: AccessMode; models: string[] }) => void;
}

export function ApiKeyModelAccess(props: ApiKeyModelAccessProps): JSX.Element {
  const [mode, setMode] = createSignal<AccessMode>(props.initialMode);
  const [models, setModels] = createSignal<string[]>(props.initialModels);
  const [isSaving, setIsSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const [saved, setSaved] = createSignal<AccessDraft>({ mode: props.initialMode, ids: props.initialModels });

  const targets = createMemo<AccessTarget[]>(() =>
    props.availableModels.map((model) => ({ id: model, label: model, mono: true }))
  );

  async function save(value: { mode: AccessMode; ids: string[] }) {
    setIsSaving(true);
    setError("");
    const updated = await settle(() =>
      api.apiKeys.updateModelAccess({ id: props.apiKeyId, mode: value.mode, models: value.ids })
    );
    setIsSaving(false);
    if (!updated.ok) {
      setError(errorText(updated.error, "Failed to update model access"));
      return;
    }
    if (!updated.value.success) {
      setError(updated.value.error);
      return;
    }
    const result = updated.value;
    setSaved({ mode: result.data.mode, ids: result.data.models });
    setMode(result.data.mode);
    setModels([...result.data.models]);
    props.onUpdated({ mode: result.data.mode, models: result.data.models });
  }

  return (
    <ApiKeyAccessPicker
      mode={mode()}
      onModeChange={setMode}
      ids={models()}
      onIdsChange={setModels}
      saved={saved()}
      isSaving={isSaving()}
      error={error()}
      onSave={(value) => void save(value)}
      title="Models"
      noun="model"
      targets={targets()}
      searchText={(target) => target.label}
      initialMode={props.initialMode}
      initialIds={props.initialModels}
      readonly={props.readonly}
      normalize={(ids) => Array.from(new Set(ids)).sort(compareIds)}
    />
  );
}
