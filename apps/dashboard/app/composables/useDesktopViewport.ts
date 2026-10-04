export function useDesktopViewport(query = "(min-width: 768px)") {
  const isDesktopViewport = ref(true);
  let mediaQuery: MediaQueryList | null = null;

  function sync(event: MediaQueryListEvent | MediaQueryList) {
    isDesktopViewport.value = event.matches;
  }

  onMounted(() => {
    mediaQuery = window.matchMedia(query);
    sync(mediaQuery);
    mediaQuery.addEventListener("change", sync);
  });

  onBeforeUnmount(() => {
    mediaQuery?.removeEventListener("change", sync);
  });

  return { isDesktopViewport };
}
