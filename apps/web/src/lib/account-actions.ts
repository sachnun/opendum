import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js";
import type { Account } from "~/lib/account-format";
import type { AccountUpdateData } from "~/lib/api-types";
import { api } from "~/api";

type TemporaryOffUnit = "minutes" | "hours" | "days";

const LONG_PRESS_MS = 600;

export const TEMPORARY_OFF_UNITS: Array<{ value: TemporaryOffUnit; label: string; multiplier: number }> = [
  { value: "minutes", label: "Minutes", multiplier: 60 * 1000 },
  { value: "hours", label: "Hours", multiplier: 60 * 60 * 1000 },
  { value: "days", label: "Days", multiplier: 24 * 60 * 60 * 1000 },
];

export interface AccountActionsHandlers {
  onActiveUpdated: (data: AccountUpdateData) => void;
  onTemporarilyDisabled: (data: AccountUpdateData) => void;
  onRenamed: (data: AccountUpdateData) => void;
  onDeleted: (id: string) => void;
}

export function createAccountActions(account: Accessor<Account>, readonly: Accessor<boolean>, handlers: AccountActionsHandlers) {
  const [isToggling, setIsToggling] = createSignal(false);
  const [isTemporaryDisabling, setIsTemporaryDisabling] = createSignal(false);
  const [savingName, setSavingName] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);
  const [editName, setEditName] = createSignal(account().name);
  const [temporaryOffAmount, setTemporaryOffAmount] = createSignal(30);
  const [temporaryOffUnit, setTemporaryOffUnit] = createSignal<TemporaryOffUnit>("minutes");
  const [temporaryOffError, setTemporaryOffError] = createSignal("");
  const [dialogOpen, setDialogOpen] = createSignal(false);
  let suppressNextToggle = false;
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;

  createEffect(
    on(
      () => account().name,
      (value) => setEditName(value)
    )
  );

  createEffect(
    on(dialogOpen, (open) => {
      if (!open) return;
      setTemporaryOffAmount(30);
      setTemporaryOffUnit("minutes");
      setTemporaryOffError("");
    })
  );

  function offUntil(): Date | null {
    const amount = Number(temporaryOffAmount());
    if (!Number.isFinite(amount) || amount < 1) return null;

    const unit = TEMPORARY_OFF_UNITS.find((entry) => entry.value === temporaryOffUnit());
    if (!unit) return null;

    return new Date(Date.now() + Math.floor(amount) * unit.multiplier);
  }

  function clearLongPress() {
    if (!longPressTimer) return;
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }

  function startLongPress(event: PointerEvent) {
    if (readonly()) return;
    if (!account().isActive || isToggling() || isTemporaryDisabling()) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;

    clearLongPress();
    longPressTimer = setTimeout(() => {
      suppressNextToggle = true;
      setDialogOpen(true);
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

  onCleanup(() => clearLongPress());

  async function toggleActive() {
    if (readonly()) return;
    if (suppressNextToggle) {
      suppressNextToggle = false;
      return;
    }

    setIsToggling(true);
    const result = await api.accounts.update({ id: account().id, isActive: !account().isActive });
    setIsToggling(false);
    if (result.success) handlers.onActiveUpdated(result.data);
  }

  async function disableTemporarily() {
    if (readonly()) return;
    const disabledUntil = offUntil();
    if (!disabledUntil) {
      setTemporaryOffError("Please choose at least 1 minute, hour, or day.");
      return;
    }

    setIsTemporaryDisabling(true);
    setTemporaryOffError("");
    const result = await api.accounts.update({ id: account().id, disabledUntil: disabledUntil.toISOString() });
    setIsTemporaryDisabling(false);
    if (!result.success) {
      setTemporaryOffError(result.error);
      return;
    }
    setDialogOpen(false);
    handlers.onTemporarilyDisabled(result.data);
  }

  async function renameAccount() {
    if (readonly()) return;
    setSavingName(true);
    const result = await api.accounts.update({ id: account().id, name: editName() });
    setSavingName(false);
    if (result.success) handlers.onRenamed(result.data);
  }

  async function deleteAccount() {
    if (readonly()) return;
    setDeleting(true);
    const result = await api.accounts.delete({ id: account().id });
    setDeleting(false);
    if (result.success) handlers.onDeleted(account().id);
  }

  return {
    isToggling,
    isTemporaryDisabling,
    savingName,
    deleting,
    editName,
    setEditName,
    temporaryOffAmount,
    setTemporaryOffAmount,
    temporaryOffUnit,
    setTemporaryOffUnit,
    temporaryOffError,
    dialogOpen,
    setDialogOpen,
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
