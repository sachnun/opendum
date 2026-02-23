"use client";

import { useCallback, useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";

const ANALYTICS_REFRESH_INTERVAL_MS = 30_000;
const STANDARD_REFRESH_INTERVAL_MS = 60_000;
const DEFAULT_REFRESH_INTERVAL_MS = STANDARD_REFRESH_INTERVAL_MS;
const MIN_REFRESH_GAP_MS = 5_000;

interface DashboardDataRefresherProps {
  intervalMs?: number;
}

function getRefreshIntervalForPath(pathname: string, fallbackIntervalMs: number): number {
  if (!pathname.startsWith("/dashboard")) {
    return 0;
  }

  if (pathname === "/dashboard") {
    return ANALYTICS_REFRESH_INTERVAL_MS;
  }

  if (pathname === "/dashboard/playground") {
    return 0;
  }

  if (
    pathname === "/dashboard/accounts" ||
    pathname.startsWith("/dashboard/accounts/") ||
    pathname === "/dashboard/models" ||
    pathname === "/dashboard/api-keys" ||
    pathname === "/dashboard/usage"
  ) {
    return STANDARD_REFRESH_INTERVAL_MS;
  }

  return fallbackIntervalMs;
}

export function DashboardDataRefresher({
  intervalMs = DEFAULT_REFRESH_INTERVAL_MS,
}: DashboardDataRefresherProps) {
  const pathname = usePathname();
  const router = useRouter();
  const previousPathnameRef = useRef(pathname);
  const lastRefreshAtRef = useRef(0);
  const activeIntervalMs = getRefreshIntervalForPath(pathname, intervalMs);

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
    if (activeIntervalMs <= 0) {
      return;
    }

    const handleVisibilityAwareRefresh = () => {
      if (document.visibilityState !== "visible") {
        return;
      }

      refresh();
    };

    const intervalId = window.setInterval(handleVisibilityAwareRefresh, activeIntervalMs);
    window.addEventListener("focus", handleVisibilityAwareRefresh);
    document.addEventListener("visibilitychange", handleVisibilityAwareRefresh);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleVisibilityAwareRefresh);
      document.removeEventListener("visibilitychange", handleVisibilityAwareRefresh);
    };
  }, [activeIntervalMs, refresh]);

  return null;
}
