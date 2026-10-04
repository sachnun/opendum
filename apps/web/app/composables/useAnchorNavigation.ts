import type { Ref } from "vue";

import type { NavItem, NavSubItem } from "~~/lib/navigation";

const HEADER_OFFSET = 112;
const PENDING_NAV_ANCHOR_KEY = "opendum:pending-nav-anchor";
const PENDING_SCROLL_RETRIES = 20;
const PENDING_SCROLL_DELAY_MS = 60;

export function useAnchorNavigation(options: { anchorIds: Ref<string[]>; onNavigate?: () => void }) {
  const route = useRoute();
  const mainContent = ref<HTMLElement | null>(null);
  const activeAnchorId = ref<string | null>(null);

  function setPendingAnchor(path: string, anchorId: string) {
    window.sessionStorage.setItem(PENDING_NAV_ANCHOR_KEY, JSON.stringify({ path, anchorId }));
  }

  function consumePendingAnchor(pathname: string) {
    const rawValue = window.sessionStorage.getItem(PENDING_NAV_ANCHOR_KEY);
    if (!rawValue) return null;

    try {
      const pendingAnchor = JSON.parse(rawValue) as { path?: string; anchorId?: string };
      if (pendingAnchor.path !== pathname || !pendingAnchor.anchorId) return null;

      window.sessionStorage.removeItem(PENDING_NAV_ANCHOR_KEY);
      return pendingAnchor.anchorId;
    } catch {
      window.sessionStorage.removeItem(PENDING_NAV_ANCHOR_KEY);
      return null;
    }
  }

  function scrollToAnchor(anchorId: string) {
    const section = document.getElementById(anchorId);
    if (!section) return false;

    section.scrollIntoView({ behavior: "smooth", block: "start" });
    activeAnchorId.value = anchorId;
    return true;
  }

  function getAnchorIdFromViewport(anchorIds: string[]) {
    let firstAvailableAnchorId: string | null = null;
    let lastPassedAnchorId: string | null = null;

    for (const anchorId of anchorIds) {
      const section = document.getElementById(anchorId);
      if (!section) continue;

      firstAvailableAnchorId ??= anchorId;

      if (section.getBoundingClientRect().top <= HEADER_OFFSET) {
        lastPassedAnchorId = anchorId;
      }
    }

    return lastPassedAnchorId ?? firstAvailableAnchorId;
  }

  function handleNavClick(item?: NavItem | NavSubItem, event?: MouseEvent) {
    if (item?.disabled) {
      event?.preventDefault();
      return;
    }

    if (item && "anchorId" in item && item.anchorId) {
      if (route.path === item.href) {
        event?.preventDefault();
        scrollToAnchor(item.anchorId);
      } else if (import.meta.client) {
        setPendingAnchor(item.href, item.anchorId);
      }
    }

    options.onNavigate?.();
  }

  watch(options.anchorIds, (anchorIds, _previousAnchorIds, onCleanup) => {
    if (anchorIds.length === 0) {
      activeAnchorId.value = null;
      return;
    }

    let rafId: number | null = null;
    const scrollTarget = mainContent.value;

    const syncActiveAnchor = () => {
      activeAnchorId.value = getAnchorIdFromViewport(anchorIds);
    };

    const scheduleSync = () => {
      if (rafId !== null) return;

      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        syncActiveAnchor();
      });
    };

    const observer = new IntersectionObserver(() => {
      scheduleSync();
    }, {
      root: null,
      rootMargin: `-${HEADER_OFFSET}px 0px -55% 0px`,
      threshold: [0, 0.25, 0.5, 0.75, 1],
    });

    for (const anchorId of anchorIds) {
      const section = document.getElementById(anchorId);
      if (section) observer.observe(section);
    }

    scheduleSync();
    window.addEventListener("scroll", scheduleSync, { passive: true });
    window.addEventListener("resize", scheduleSync);
    scrollTarget?.addEventListener("scroll", scheduleSync, { passive: true });

    onCleanup(() => {
      observer.disconnect();
      window.removeEventListener("scroll", scheduleSync);
      window.removeEventListener("resize", scheduleSync);
      scrollTarget?.removeEventListener("scroll", scheduleSync);
      if (rafId !== null) window.cancelAnimationFrame(rafId);
    });
  }, { immediate: true });

  watch(() => route.path, () => {
    const pendingAnchorId = consumePendingAnchor(route.path);
    if (!pendingAnchorId) return;

    let retriesLeft = PENDING_SCROLL_RETRIES;

    const tryScroll = () => {
      if (scrollToAnchor(pendingAnchorId)) return;

      retriesLeft -= 1;
      if (retriesLeft <= 0) return;

      window.setTimeout(tryScroll, PENDING_SCROLL_DELAY_MS);
    };

    tryScroll();
  }, { immediate: true });

  return { mainContent, activeAnchorId, handleNavClick, scrollToAnchor };
}
