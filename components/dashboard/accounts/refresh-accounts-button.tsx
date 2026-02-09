"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function RefreshAccountsButton() {
  const router = useRouter();
  const [isRefreshing, startRefresh] = useTransition();

  const handleRefresh = () => {
    startRefresh(() => {
      router.refresh();
    });
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      onClick={handleRefresh}
      disabled={isRefreshing}
      className="size-9 sm:w-auto sm:px-4"
      aria-label="Refresh provider accounts"
    >
      <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
      <span className="hidden sm:inline">Refresh</span>
    </Button>
  );
}
