const CLOSE_THRESHOLD_PX = 96;

export function useMobileSidebar() {
  const mobileOpen = ref(false);
  const dragX = ref(0);
  const isDragging = ref(false);
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
    isDragging.value = false;
    dragX.value = 0;
  }

  function closeMobileSidebar(raw?: unknown) {
    const keepDragOffset = (raw as { keepDragOffset?: boolean } | undefined)?.keepDragOffset ?? false;
    mobileOpen.value = false;

    if (keepDragOffset) {
      swipeStartX = null;
      swipePointerId = null;
      isDragging.value = false;
      swipeResetTimer = setTimeout(resetSwipe, 350);
      return;
    }

    resetSwipe();
  }

  function openMobileSidebar() {
    resetSwipe();
    mobileOpen.value = true;
  }

  function overlayClick(event: MouseEvent) {
    if (suppressClick) {
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (isDragging.value || dragX.value !== 0) {
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
    if (!mobileOpen.value) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;

    swipeStartX = event.clientX;
    swipePointerId = event.pointerId;
    isDragging.value = false;
    dragX.value = 0;
  }

  function overlayPointerMove(event: PointerEvent) {
    if (swipeStartX === null || swipePointerId !== event.pointerId) return;

    const deltaX = event.clientX - swipeStartX;
    if (deltaX >= 0) {
      if (isDragging.value) event.preventDefault();
      dragX.value = 0;
      return;
    }

    isDragging.value = true;
    dragX.value = deltaX;
    event.preventDefault();
  }

  function finishSwipe(event?: PointerEvent) {
    if (event && swipePointerId !== event.pointerId) return;

    const wasDragging = isDragging.value;
    const shouldClose = Math.abs(dragX.value) >= CLOSE_THRESHOLD_PX;
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
