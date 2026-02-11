"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PROVIDER_ACCOUNTS_REFRESH_EVENT } from "./constants";

export function RefreshAccountsButton() {
  const router = useRouter();
  const [isRefreshing, startRefresh] = useTransition();

  const handleRefresh = () => {
    startRefresh(() => {
      window.dispatchEvent(new CustomEvent(PROVIDER_ACCOUNTS_REFRESH_EVENT));
      router.refresh();
    });
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="default"
        onClick={handleRefresh}
        disabled={isRefreshing}
        className="hidden md:inline-flex"
        aria-label="Refresh provider accounts"
      >
        <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
        <span>Refresh</span>
      </Button>

      <Button
        type="button"
        variant="outline"
        size="icon-lg"
        onClick={handleRefresh}
        disabled={isRefreshing}
        className="fixed bottom-4 right-4 z-40 rounded-full bg-background shadow-lg md:hidden dark:bg-background"
        aria-label="Refresh provider accounts"
      >
        <RefreshCw className={`h-5 w-5 ${isRefreshing ? "animate-spin" : ""}`} />
      </Button>
    </>
  );
}
