import { createMemo, createSignal, type JSX } from "solid-js";
import { compareText } from "@opendum/models/compare";
import { labelOf } from "@opendum/providers/provider-accounts";
import type { AccessMode } from "~/lib/access-draft";
import { api } from "~/api";
import { errorText, settle } from "~/lib/settle";
import { ApiKeyAccessPicker, type AccessDraft, type AccessTarget } from "~/components/api-key/ApiKeyAccessPicker";

export interface ProviderAccountOption {
  id: string;
  provider: string;
  name: string;
  email: string | null;
}

export interface ApiKeyAccountAccessProps {
  apiKeyId: string;
  availableAccounts: ProviderAccountOption[];
  initialMode: AccessMode;
  initialAccounts: string[];
  readonly?: boolean;
  onUpdated: (value: { mode: AccessMode; accounts: string[] }) => void;
}

export function ApiKeyAccountAccess(props: ApiKeyAccountAccessProps): JSX.Element {
  const [mode, setMode] = createSignal<AccessMode>(props.initialMode);
  const [accounts, setAccounts] = createSignal<string[]>(props.initialAccounts);
  const [isSaving, setIsSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const [saved, setSaved] = createSignal<AccessDraft>({ mode: props.initialMode, ids: props.initialAccounts });

  const targets = createMemo<AccessTarget[]>(() =>
    props.availableAccounts.map((account) => ({
      id: account.id,
      label: account.email ? `${account.name} (${account.email})` : account.name,
      detail: `${labelOf(account.provider)}${account.email ? ` - ${account.email}` : ""}`,
    }))
  );

  function searchText(target: AccessTarget): string {
    const account = props.availableAccounts.find((entry) => entry.id === target.id);
    return account ? `${account.provider} ${account.name} ${account.email ?? ""}` : target.id;
  }

  async function save(value: { mode: AccessMode; ids: string[] }) {
    setIsSaving(true);
    setError("");
    const updated = await settle(() =>
      api.apiKeys.updateAccountAccess({ id: props.apiKeyId, mode: value.mode, accounts: value.ids })
    );
    setIsSaving(false);
    if (!updated.ok) {
      setError(errorText(updated.error, "Failed to update account access"));
      return;
    }
    if (!updated.value.success) {
      setError(updated.value.error);
      return;
    }
    const result = updated.value;
    setSaved({ mode: result.data.mode, ids: result.data.accounts });
    setMode(result.data.mode);
    setAccounts([...result.data.accounts]);
    props.onUpdated({ mode: result.data.mode, accounts: result.data.accounts });
  }

  return (
    <ApiKeyAccessPicker
      mode={mode()}
      onModeChange={setMode}
      ids={accounts()}
      onIdsChange={setAccounts}
      saved={saved()}
      isSaving={isSaving()}
      error={error()}
      onSave={(value) => void save(value)}
      title="Accounts"
      noun="account"
      targets={targets()}
      searchText={searchText}
      initialMode={props.initialMode}
      initialIds={props.initialAccounts}
      readonly={props.readonly}
      normalize={(ids) => Array.from(new Set(ids)).sort((a, b) => compareText(a, b))}
    />
  );
}
