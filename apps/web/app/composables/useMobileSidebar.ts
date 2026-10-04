const MOBILE_SIDEBAR_SWIPE_CLOSE_THRESHOLD_PX = 96;

export function useMobileSidebar() {
  const mobileOpen = ref(false);
  const mobileSidebarDragX = ref(0);
  const isMobileSidebarDragging = ref(false);
  let swipeStartX: number | null = null;
  let swipePointerId: number | null = null;
  let suppressNextOverlayClick = false;
  let swipeResetTimer: ReturnType<typeof setTimeout> | null = null;

  function resetMobileSidebarSwipe() {
    if (swipeResetTimer) {
      clearTimeout(swipeResetTimer);
      swipeResetTimer = null;
    }

    swipeStartX = null;
    swipePointerId = null;
    isMobileSidebarDragging.value = false;
    mobileSidebarDragX.value = 0;
  }

  function closeMobileSidebar(raw?: unknown) {
    const keepDragOffset = (raw as { keepDragOffset?: boolean } | undefined)?.keepDragOffset ?? false;
    mobileOpen.value = false;

    if (keepDragOffset) {
      swipeStartX = null;
      swipePointerId = null;
      isMobileSidebarDragging.value = false;
      swipeResetTimer = setTimeout(resetMobileSidebarSwipe, 350);
      return;
    }

    resetMobileSidebarSwipe();
  }

  function openMobileSidebar() {
    resetMobileSidebarSwipe();
    mobileOpen.value = true;
  }

  function handleMobileOverlayClick(event: MouseEvent) {
    if (suppressNextOverlayClick) {
      suppressNextOverlayClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (isMobileSidebarDragging.value || mobileSidebarDragX.value !== 0) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    closeMobileSidebar();
  }

  function handleMobileSheetPointerDownOutside(event: Event) {
    if (swipeStartX === null) return;
    event.preventDefault();
  }

  function handleMobileOverlayPointerDown(event: PointerEvent) {
    if (!mobileOpen.value) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;

    swipeStartX = event.clientX;
    swipePointerId = event.pointerId;
    isMobileSidebarDragging.value = false;
    mobileSidebarDragX.value = 0;
  }

  function handleMobileOverlayPointerMove(event: PointerEvent) {
    if (swipeStartX === null || swipePointerId !== event.pointerId) return;

    const deltaX = event.clientX - swipeStartX;
    if (deltaX >= 0) {
      if (isMobileSidebarDragging.value) event.preventDefault();
      mobileSidebarDragX.value = 0;
      return;
    }

    isMobileSidebarDragging.value = true;
    mobileSidebarDragX.value = deltaX;
    event.preventDefault();
  }

  function finishMobileOverlaySwipe(event?: PointerEvent) {
    if (event && swipePointerId !== event.pointerId) return;

    const wasDragging = isMobileSidebarDragging.value;
    const shouldClose = Math.abs(mobileSidebarDragX.value) >= MOBILE_SIDEBAR_SWIPE_CLOSE_THRESHOLD_PX;
    if (shouldClose) {
      closeMobileSidebar({ keepDragOffset: true });
      return;
    }

    resetMobileSidebarSwipe();
    suppressNextOverlayClick = wasDragging;
  }

  return {
    mobileOpen,
    mobileSidebarDragX,
    isMobileSidebarDragging,
    openMobileSidebar,
    closeMobileSidebar,
    resetMobileSidebarSwipe,
    handleMobileOverlayClick,
    handleMobileSheetPointerDownOutside,
    handleMobileOverlayPointerDown,
    handleMobileOverlayPointerMove,
    finishMobileOverlaySwipe,
  };
}
