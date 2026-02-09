"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { LogOut, Menu } from "lucide-react";
import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useState } from "react";
import { type NavItem, primaryNavigation, supportNavigation } from "@/lib/navigation";
import { useSubNavigation } from "@/components/layout/use-sub-navigation";

export function MobileNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const { handleSubItemClick, isSubItemActive } = useSubNavigation(pathname, primaryNavigation);

  const renderNavItem = (item: NavItem) => {
    const isActive =
      pathname === item.href ||
      (item.href !== "/dashboard" && pathname.startsWith(item.href));

    return (
      <div key={item.name} className="space-y-1">
        <Link
          href={item.href}
          onClick={() => setOpen(false)}
          className={cn(
            "group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all",
            isActive
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground"
          )}
        >
          <item.icon
            className={cn(
              "h-4 w-4",
              isActive ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"
            )}
          />
          {item.name}
        </Link>

        {item.children?.length ? (
          <div className="ml-6 space-y-1 border-l border-border/60 pl-3">
            {item.children.map((subItem) => {
              const isSubActive = isSubItemActive(subItem);

              return (
                <Link
                  key={`${item.name}-${subItem.name}`}
                  href={subItem.href}
                  onClick={(event) => {
                    handleSubItemClick(event, subItem);
                    setOpen(false);
                  }}
                  className={cn(
                    "block rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                    isSubActive
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  )}
                >
                  {subItem.name}
                </Link>
              );
            })}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="rounded-lg border border-border bg-card md:hidden"
        >
          <Menu className="h-5 w-5" />
          <span className="sr-only">Toggle menu</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="flex w-[78vw] max-w-[18rem] flex-col gap-0 p-0">
        <SheetHeader className="border-b border-border px-5 py-4">
          <SheetTitle className="text-left">
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-2 text-base font-semibold tracking-tight"
              onClick={() => setOpen(false)}
            >
              <span className="h-2.5 w-2.5 rounded-full bg-primary" />
              Opendum
            </Link>
          </SheetTitle>
        </SheetHeader>
        <nav className="flex flex-1 flex-col overflow-y-auto px-3 py-4">
          <div className="space-y-1">{primaryNavigation.map(renderNavItem)}</div>
          <div className="mt-auto space-y-1 border-t border-border/60 pt-4">
            {supportNavigation.map(renderNavItem)}
          </div>
        </nav>
        <div className="border-t border-border p-3">
          <Button
            variant="ghost"
            className="h-10 w-full justify-start gap-3 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => {
              setOpen(false);
              signOut({ callbackUrl: "/" });
            }}
          >
            <LogOut className="h-4 w-4" />
            Sign Out
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
