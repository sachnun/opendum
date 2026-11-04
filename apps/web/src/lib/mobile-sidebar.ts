import { createSignal } from "solid-js";

const CLOSE_THRESHOLD_PX = 96;

export function createMobileSidebar() {
  const [mobileOpen, setMobileOpen] = createSignal(false);
  const [dragX, setDragX] = createSignal(0);
  const [isDragging, setIsDragging] = createSignal(false);
  let swipeStartX: number | null = null;
  let swipePointerId: number | null = null;
  let suppressClick = false;
  let swipeResetTimer: ReturnType<typeof setTimeout> | null = null;

  function resetSwipe() {
    if (swipeResetTimer) {
      clearTimeout(swipeResetTimer);
      swipeResetTimer = null;
    }

    swipeStartX = null;
    swipePointerId = null;
    setIsDragging(false);
    setDragX(0);
  }

  function closeMobileSidebar(raw?: unknown) {
    const keepDragOffset = (raw as { keepDragOffset?: boolean } | undefined)?.keepDragOffset ?? false;
    setMobileOpen(false);

    if (keepDragOffset) {
      swipeStartX = null;
      swipePointerId = null;
      setIsDragging(false);
      swipeResetTimer = setTimeout(resetSwipe, 350);
      return;
    }

    resetSwipe();
  }

  function openMobileSidebar() {
    resetSwipe();
    setMobileOpen(true);
  }

  function overlayClick(event: MouseEvent) {
    if (suppressClick) {
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (isDragging() || dragX() !== 0) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    closeMobileSidebar();
  }

  function sheetPointerDown(event: Event) {
    if (swipeStartX === null) return;
    event.preventDefault();
  }

  function overlayPointerDown(event: PointerEvent) {
    if (!mobileOpen()) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;

    swipeStartX = event.clientX;
    swipePointerId = event.pointerId;
    setIsDragging(false);
    setDragX(0);
  }

  function overlayPointerMove(event: PointerEvent) {
    if (swipeStartX === null || swipePointerId !== event.pointerId) return;

    const deltaX = event.clientX - swipeStartX;
    if (deltaX >= 0) {
      if (isDragging()) event.preventDefault();
      setDragX(0);
      return;
    }

    setIsDragging(true);
    setDragX(deltaX);
    event.preventDefault();
  }

  function finishSwipe(event?: PointerEvent) {
    if (event && swipePointerId !== event.pointerId) return;

    const wasDragging = isDragging();
    const shouldClose = Math.abs(dragX()) >= CLOSE_THRESHOLD_PX;
    if (shouldClose) {
      closeMobileSidebar({ keepDragOffset: true });
      return;
    }

    resetSwipe();
    suppressClick = wasDragging;
  }

  return {
    mobileOpen,
    dragX,
    isDragging,
    openMobileSidebar,
    closeMobileSidebar,
    resetSwipe,
    overlayClick,
    sheetPointerDown,
    overlayPointerDown,
    overlayPointerMove,
    finishSwipe,
  };
}
