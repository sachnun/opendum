import type { Account } from "~~/lib/account-format";
import type { AccountUpdateData } from "~~/lib/api-types";

type TemporaryOffUnit = "minutes" | "hours" | "days";

const LONG_PRESS_MS = 600;
const TEMPORARY_OFF_UNITS: Array<{ value: TemporaryOffUnit; label: string; multiplier: number }> = [
  { value: "minutes", label: "Minutes", multiplier: 60 * 1000 },
  { value: "hours", label: "Hours", multiplier: 60 * 60 * 1000 },
  { value: "days", label: "Days", multiplier: 24 * 60 * 60 * 1000 },
];

export function useAccountActions(
  props: { account: Account; readonly?: boolean },
  handlers: {
    onActiveUpdated: (data: AccountUpdateData) => void;
    onTemporarilyDisabled: (data: AccountUpdateData) => void;
    onRenamed: (data: AccountUpdateData) => void;
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
  const dialogOpen = ref(false);
  let suppressNextToggle = false;
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;

  watch(() => props.account.name, (value) => {
    editName.value = value;
  });

  watch(dialogOpen, (open) => {
    if (!open) return;

    temporaryOffAmount.value = 30;
    temporaryOffUnit.value = "minutes";
    temporaryOffError.value = "";
  });

  function offUntil(): Date | null {
    const amount = Number(temporaryOffAmount.value);
    if (!Number.isFinite(amount) || amount < 1) return null;

    const unit = TEMPORARY_OFF_UNITS.find((entry) => entry.value === temporaryOffUnit.value);
    if (!unit) return null;

    return new Date(Date.now() + Math.floor(amount) * unit.multiplier);
  }

  function clearLongPress() {
    if (!longPressTimer) return;

    clearTimeout(longPressTimer);
    longPressTimer = null;
  }

  function startLongPress(event: PointerEvent) {
    if (props.readonly) return;
    if (!props.account.isActive || isToggling.value || isTemporaryDisabling.value) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;

    clearLongPress();
    longPressTimer = setTimeout(() => {
      suppressNextToggle = true;
      dialogOpen.value = true;
      clearLongPress();
    }, LONG_PRESS_MS);
  }

  function finishLongPress() {
    clearLongPress();
  }

  function toggleClick(event: Event) {
    if (!suppressNextToggle) return;

    event.preventDefault();
    event.stopPropagation();
    setTimeout(() => {
      suppressNextToggle = false;
    }, 0);
  }

  onBeforeUnmount(() => {
    clearLongPress();
  });

  async function toggleActive() {
    if (props.readonly) return;
    if (suppressNextToggle) {
      suppressNextToggle = false;
      return;
    }

    isToggling.value = true;
    const result = await api.accounts.update({ id: props.account.id, isActive: !props.account.isActive });
    isToggling.value = false;
    if (result.success) handlers.onActiveUpdated(result.data);
  }

  async function disableTemporarily() {
    if (props.readonly) return;
    const disabledUntil = offUntil();
    if (!disabledUntil) {
      temporaryOffError.value = "Please choose at least 1 minute, hour, or day.";
      return;
    }

    isTemporaryDisabling.value = true;
    temporaryOffError.value = "";
    const result = await api.accounts.update({ id: props.account.id, disabledUntil: disabledUntil.toISOString() });
    isTemporaryDisabling.value = false;
    if (!result.success) {
      temporaryOffError.value = result.error;
      return;
    }
    dialogOpen.value = false;
    handlers.onTemporarilyDisabled(result.data);
  }

  async function renameAccount() {
    if (props.readonly) return;
    savingName.value = true;
    const result = await api.accounts.update({ id: props.account.id, name: editName.value });
    savingName.value = false;
    if (result.success) handlers.onRenamed(result.data);
  }

  async function deleteAccount() {
    if (props.readonly) return;
    deleting.value = true;
    const result = await api.accounts.delete({ id: props.account.id });
    deleting.value = false;
    if (result.success) handlers.onDeleted(props.account.id);
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
    dialogOpen,
    offUntil,
    startLongPress,
    finishLongPress,
    toggleClick,
    toggleActive,
    disableTemporarily,
    renameAccount,
    deleteAccount,
  };
}
