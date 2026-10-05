import type { Account } from "#shared/account/format";
import type { ProviderAccountUpdateData } from "#shared/api";

type TemporaryOffUnit = "minutes" | "hours" | "days";

const TEMPORARY_OFF_LONG_PRESS_MS = 600;
const TEMPORARY_OFF_UNITS: Array<{ value: TemporaryOffUnit; label: string; multiplier: number }> = [
  { value: "minutes", label: "Minutes", multiplier: 60 * 1000 },
  { value: "hours", label: "Hours", multiplier: 60 * 60 * 1000 },
  { value: "days", label: "Days", multiplier: 24 * 60 * 60 * 1000 },
];

export function useProviderAccountActions(
  props: { account: Account; readonly?: boolean },
  handlers: {
    onActiveUpdated: (data: ProviderAccountUpdateData) => void;
    onTemporarilyDisabled: (data: ProviderAccountUpdateData) => void;
    onRenamed: (data: ProviderAccountUpdateData) => void;
    onDeleted: (id: string) => void;
  }
) {
  const api = useApi();
  const isToggling = ref(false);
  const isTemporaryDisabling = ref(false);
  const savingName = ref(false);
  const deleting = ref(false);
  const editName = ref(props.account.name);
  const temporaryOffAmount = ref(30);
  const temporaryOffUnit = ref<TemporaryOffUnit>("minutes");
  const temporaryOffError = ref("");
  const temporaryOffDialogOpen = ref(false);
  let suppressNextToggle = false;
  let temporaryOffLongPressTimer: ReturnType<typeof setTimeout> | null = null;

  watch(() => props.account.name, (value) => {
    editName.value = value;
  });

  watch(temporaryOffDialogOpen, (open) => {
    if (!open) return;

    temporaryOffAmount.value = 30;
    temporaryOffUnit.value = "minutes";
    temporaryOffError.value = "";
  });

  function getTemporaryOffUntil(): Date | null {
    const amount = Number(temporaryOffAmount.value);
    if (!Number.isFinite(amount) || amount < 1) return null;

    const unit = TEMPORARY_OFF_UNITS.find((entry) => entry.value === temporaryOffUnit.value);
    if (!unit) return null;

    return new Date(Date.now() + Math.floor(amount) * unit.multiplier);
  }

  function clearTemporaryOffLongPress() {
    if (!temporaryOffLongPressTimer) return;

    clearTimeout(temporaryOffLongPressTimer);
    temporaryOffLongPressTimer = null;
  }

  function startTemporaryOffLongPress(event: PointerEvent) {
    if (props.readonly) return;
    if (!props.account.isActive || isToggling.value || isTemporaryDisabling.value) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;

    clearTemporaryOffLongPress();
    temporaryOffLongPressTimer = setTimeout(() => {
      suppressNextToggle = true;
      temporaryOffDialogOpen.value = true;
      clearTemporaryOffLongPress();
    }, TEMPORARY_OFF_LONG_PRESS_MS);
  }

  function finishTemporaryOffLongPress() {
    clearTemporaryOffLongPress();
  }

  function handleTemporaryOffToggleClick(event: Event) {
    if (!suppressNextToggle) return;

    event.preventDefault();
    event.stopPropagation();
    setTimeout(() => {
      suppressNextToggle = false;
    }, 0);
  }

  onBeforeUnmount(() => {
    clearTemporaryOffLongPress();
  });

  async function toggleActive() {
    if (props.readonly) return;
    if (suppressNextToggle) {
      suppressNextToggle = false;
      return;
    }

    isToggling.value = true;
    try {
      const result = await api.accounts.update({ id: props.account.id, isActive: !props.account.isActive });
      if (!result.success) throw new Error(result.error);
      handlers.onActiveUpdated(result.data);
    } finally {
      isToggling.value = false;
    }
  }

  async function disableTemporarily() {
    if (props.readonly) return;
    const disabledUntil = getTemporaryOffUntil();
    if (!disabledUntil) {
      temporaryOffError.value = "Please choose at least 1 minute, hour, or day.";
      return;
    }

    isTemporaryDisabling.value = true;
    temporaryOffError.value = "";
    try {
      const result = await api.accounts.update({ id: props.account.id, disabledUntil: disabledUntil.toISOString() });
      if (!result.success) throw new Error(result.error);
      temporaryOffDialogOpen.value = false;
      handlers.onTemporarilyDisabled(result.data);
    } catch (error) {
      temporaryOffError.value = error instanceof Error ? error.message : "Failed to disable account temporarily";
    } finally {
      isTemporaryDisabling.value = false;
    }
  }

  async function renameAccount() {
    if (props.readonly) return;
    savingName.value = true;
    try {
      const result = await api.accounts.update({ id: props.account.id, name: editName.value });
      if (!result.success) throw new Error(result.error);
      handlers.onRenamed(result.data);
    } finally {
      savingName.value = false;
    }
  }

  async function deleteAccount() {
    if (props.readonly) return;
    deleting.value = true;
    try {
      const result = await api.accounts.delete({ id: props.account.id });
      if (!result.success) throw new Error(result.error);
      handlers.onDeleted(props.account.id);
    } finally {
      deleting.value = false;
    }
  }

  return {
    TEMPORARY_OFF_UNITS,
    isToggling,
    isTemporaryDisabling,
    savingName,
    deleting,
    editName,
    temporaryOffAmount,
    temporaryOffUnit,
    temporaryOffError,
    temporaryOffDialogOpen,
    getTemporaryOffUntil,
    startTemporaryOffLongPress,
    finishTemporaryOffLongPress,
    handleTemporaryOffToggleClick,
    toggleActive,
    disableTemporarily,
    renameAccount,
    deleteAccount,
  };
}
