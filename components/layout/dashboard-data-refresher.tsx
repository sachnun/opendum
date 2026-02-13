"use client";

import { useCallback, useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";

const DEFAULT_REFRESH_INTERVAL_MS = 30_000;
const MIN_REFRESH_GAP_MS = 5_000;

interface DashboardDataRefresherProps {
  intervalMs?: number;
}

export function DashboardDataRefresher({
  intervalMs = DEFAULT_REFRESH_INTERVAL_MS,
}: DashboardDataRefresherProps) {
  const pathname = usePathname();
  const router = useRouter();
  const previousPathnameRef = useRef(pathname);
  const lastRefreshAtRef = useRef(0);

  const refresh = useCallback(() => {
    const now = Date.now();
    if (now - lastRefreshAtRef.current < MIN_REFRESH_GAP_MS) {
      return;
    }

    lastRefreshAtRef.current = now;
    router.refresh();
  }, [router]);

  useEffect(() => {
    if (pathname === previousPathnameRef.current) {
      return;
    }

    previousPathnameRef.current = pathname;
    refresh();
  }, [pathname, refresh]);

  useEffect(() => {
    if (intervalMs <= 0) {
      return;
    }

    const handleVisibilityAwareRefresh = () => {
      if (document.visibilityState !== "visible") {
        return;
      }

      refresh();
    };

    const intervalId = window.setInterval(handleVisibilityAwareRefresh, intervalMs);
    window.addEventListener("focus", handleVisibilityAwareRefresh);
    document.addEventListener("visibilitychange", handleVisibilityAwareRefresh);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleVisibilityAwareRefresh);
      document.removeEventListener("visibilitychange", handleVisibilityAwareRefresh);
    };
  }, [intervalMs, refresh]);

  return null;
}
