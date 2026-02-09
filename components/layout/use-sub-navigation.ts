"use client";

import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import type { NavItem, NavSubItem } from "@/lib/navigation";

const PENDING_NAV_ANCHOR_KEY = "opendum:pending-nav-anchor";
const HEADER_OFFSET = 112;
const PENDING_SCROLL_RETRIES = 20;
const PENDING_SCROLL_DELAY_MS = 60;

interface PendingNavAnchor {
  path: string;
  anchorId: string;
}

function getAnchorIdsForPath(pathname: string, navigationItems: NavItem[]): string[] {
  return navigationItems.flatMap((item) =>
    (item.children ?? [])
      .filter((subItem) => subItem.href === pathname && subItem.anchorId)
      .map((subItem) => subItem.anchorId as string)
  );
}

function setPendingAnchor(path: string, anchorId: string) {
  const payload: PendingNavAnchor = { path, anchorId };
  window.sessionStorage.setItem(PENDING_NAV_ANCHOR_KEY, JSON.stringify(payload));
}

function consumePendingAnchor(pathname: string): string | null {
  const rawValue = window.sessionStorage.getItem(PENDING_NAV_ANCHOR_KEY);
  if (!rawValue) {
    return null;
  }

  try {
    const pendingAnchor = JSON.parse(rawValue) as PendingNavAnchor;
    if (pendingAnchor.path !== pathname || !pendingAnchor.anchorId) {
      return null;
    }

    window.sessionStorage.removeItem(PENDING_NAV_ANCHOR_KEY);
    return pendingAnchor.anchorId;
  } catch {
    window.sessionStorage.removeItem(PENDING_NAV_ANCHOR_KEY);
    return null;
  }
}

function getAnchorIdFromViewport(anchorIds: string[]): string | null {
  let firstAvailableAnchorId: string | null = null;
  let lastPassedAnchorId: string | null = null;

  for (const anchorId of anchorIds) {
    const section = document.getElementById(anchorId);
    if (!section) {
      continue;
    }

    if (!firstAvailableAnchorId) {
      firstAvailableAnchorId = anchorId;
    }

    if (section.getBoundingClientRect().top <= HEADER_OFFSET) {
      lastPassedAnchorId = anchorId;
    }
  }

  return lastPassedAnchorId ?? firstAvailableAnchorId;
}

export function useSubNavigation(pathname: string, navigationItems: NavItem[]) {
  const [activeAnchorId, setActiveAnchorId] = useState<string | null>(null);

  const anchorIds = useMemo(
    () => getAnchorIdsForPath(pathname, navigationItems),
    [pathname, navigationItems]
  );

  const scrollToAnchor = useCallback((anchorId: string): boolean => {
    const section = document.getElementById(anchorId);
    if (!section) {
      return false;
    }

    section.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveAnchorId(anchorId);
    return true;
  }, []);

  const handleSubItemClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>, subItem: NavSubItem) => {
      if (!subItem.anchorId) {
        return;
      }

      if (pathname === subItem.href) {
        event.preventDefault();
        scrollToAnchor(subItem.anchorId);
        return;
      }

      setPendingAnchor(subItem.href, subItem.anchorId);
    },
    [pathname, scrollToAnchor]
  );

  const isSubItemActive = useCallback(
    (subItem: NavSubItem) => {
      if (pathname !== subItem.href) {
        return false;
      }

      if (!subItem.anchorId) {
        return true;
      }

      return activeAnchorId === subItem.anchorId;
    },
    [activeAnchorId, pathname]
  );

  useEffect(() => {
    if (anchorIds.length === 0) {
      return;
    }

    let rafId: number | null = null;

    const syncActiveAnchor = () => {
      const nextActiveAnchor = getAnchorIdFromViewport(anchorIds);
      setActiveAnchorId((previous) =>
        previous === nextActiveAnchor ? previous : nextActiveAnchor
      );
    };

    const scheduleSync = () => {
      if (rafId !== null) {
        return;
      }

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
      if (section) {
        observer.observe(section);
      }
    }

    scheduleSync();

    window.addEventListener("scroll", scheduleSync, { passive: true });
    window.addEventListener("resize", scheduleSync);

    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", scheduleSync);
      window.removeEventListener("resize", scheduleSync);
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [anchorIds]);

  useEffect(() => {
    if (anchorIds.length === 0) {
      return;
    }

    const pendingAnchorId = consumePendingAnchor(pathname);
    if (!pendingAnchorId) {
      return;
    }

    let retriesLeft = PENDING_SCROLL_RETRIES;

    const tryScroll = () => {
      if (scrollToAnchor(pendingAnchorId)) {
        return;
      }

      retriesLeft -= 1;
      if (retriesLeft <= 0) {
        return;
      }

      window.setTimeout(tryScroll, PENDING_SCROLL_DELAY_MS);
    };

    tryScroll();
  }, [anchorIds.length, pathname, scrollToAnchor]);

  return {
    handleSubItemClick,
    isSubItemActive,
  };
}
