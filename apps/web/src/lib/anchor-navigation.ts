import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js";
import { parseJson } from "~/lib/settle";
import type { NavItem, NavSubItem } from "~/lib/navigation";

const HEADER_OFFSET = 112;
const PENDING_KEY = "opendum:pending-nav-anchor";
const PENDING_SCROLL_RETRIES = 20;
const SCROLL_DELAY_MS = 60;

export interface AnchorNavigationOptions {
  anchorIds: Accessor<string[]>;
  path: Accessor<string>;
  hash: Accessor<string>;
  onNavigate?: () => void;
}

export function createAnchorNavigation(options: AnchorNavigationOptions) {
  const [mainContent, setMainContent] = createSignal<HTMLElement | null>(null);
  const [activeAnchorId, setActiveAnchorId] = createSignal<string | null>(null);

  function setPendingAnchor(path: string, anchorId: string) {
    window.sessionStorage.setItem(PENDING_KEY, JSON.stringify({ path, anchorId }));
  }

  function consumePendingAnchor(pathname: string) {
    const rawValue = window.sessionStorage.getItem(PENDING_KEY);
    if (!rawValue) return null;

    const pendingAnchor = parseJson(rawValue) as { path?: string; anchorId?: string } | null;
    if (!pendingAnchor || pendingAnchor.path !== pathname || !pendingAnchor.anchorId) {
      window.sessionStorage.removeItem(PENDING_KEY);
      return null;
    }
    window.sessionStorage.removeItem(PENDING_KEY);
    return pendingAnchor.anchorId;
  }

  function scrollToAnchor(anchorId: string) {
    const section = document.getElementById(anchorId);
    if (!section) return false;

    section.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveAnchorId(anchorId);
    return true;
  }

  function anchorAt(anchorIds: string[]) {
    let firstAnchor: string | null = null;
    let lastAnchor: string | null = null;

    for (const anchorId of anchorIds) {
      const section = document.getElementById(anchorId);
      if (!section) continue;

      firstAnchor ??= anchorId;

      if (section.getBoundingClientRect().top <= HEADER_OFFSET) {
        lastAnchor = anchorId;
      }
    }

    return lastAnchor ?? firstAnchor;
  }

  function handleNavClick(item?: NavItem | NavSubItem, event?: MouseEvent) {
    if (item?.disabled) {
      event?.preventDefault();
      return;
    }

    if (item && "anchorId" in item && item.anchorId) {
      if (options.path() === item.href) {
        event?.preventDefault();
        scrollToAnchor(item.anchorId);
      } else {
        setPendingAnchor(item.href, item.anchorId);
      }
    }

    options.onNavigate?.();
  }

  createEffect(
    on(options.anchorIds, (anchorIds) => {
      if (anchorIds.length === 0) {
        setActiveAnchorId(null);
        return;
      }

      let rafId: number | null = null;
      const scrollTarget = mainContent();

      const syncActiveAnchor = () => setActiveAnchorId(anchorAt(anchorIds));

      const scheduleSync = () => {
        if (rafId !== null) return;

        rafId = window.requestAnimationFrame(() => {
          rafId = null;
          syncActiveAnchor();
        });
      };

      const observer = new IntersectionObserver(
        () => {
          scheduleSync();
        },
        {
          root: null,
          rootMargin: `-${HEADER_OFFSET}px 0px -55% 0px`,
          threshold: [0, 0.25, 0.5, 0.75, 1],
        }
      );

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
    })
  );

  createEffect(
    on(options.path, (path) => {
      const pendingAnchorId = consumePendingAnchor(path);
      if (!pendingAnchorId) return;

      let retriesLeft = PENDING_SCROLL_RETRIES;

      const tryScroll = () => {
        if (scrollToAnchor(pendingAnchorId)) return;

        retriesLeft -= 1;
        if (retriesLeft <= 0) return;

        window.setTimeout(tryScroll, SCROLL_DELAY_MS);
      };

      tryScroll();
    })
  );

  return { mainContent, setMainContent, activeAnchorId, handleNavClick, scrollToAnchor };
}
