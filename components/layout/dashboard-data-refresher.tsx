"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";

export function DashboardDataRefresher() {
  const pathname = usePathname();
  const router = useRouter();
  const previousPathnameRef = useRef(pathname);

  useEffect(() => {
    if (pathname === previousPathnameRef.current) {
      return;
    }

    previousPathnameRef.current = pathname;
    router.refresh();
  }, [pathname, router]);

  return null;
}
