import { createSignal, onCleanup, onMount, type Accessor } from "solid-js";

export function createDesktopViewport(query = "(min-width: 768px)"): Accessor<boolean> {
  const [isDesktopViewport, setIsDesktopViewport] = createSignal(true);
  let mediaQuery: MediaQueryList | null = null;

  const sync = (event: MediaQueryListEvent | MediaQueryList) => setIsDesktopViewport(event.matches);

  onMount(() => {
    mediaQuery = window.matchMedia(query);
    sync(mediaQuery);
    mediaQuery.addEventListener("change", sync);
  });

  onCleanup(() => {
    mediaQuery?.removeEventListener("change", sync);
  });

  return isDesktopViewport;
}
