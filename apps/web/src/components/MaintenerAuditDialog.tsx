import { useCallback, useEffect, useRef, useState } from "react";
import type { MaintenerAuditSearchUser, MaintenerAuditUser } from "../lib/dashboard-api-types";
import { useDashboardApi } from "../hooks/useDashboardApi";
import { UiDialog } from "./ui/UiDialog";
import { UiIcon } from "./ui/UiIcon";

const PAGE_SIZE = 12;
const SCROLL_LOAD_THRESHOLD = 48;

function userInitial(user: MaintenerAuditSearchUser) {
  return (user.name?.[0] || user.email?.[0] || "U").toUpperCase();
}

function canLoadQuery(value: string) {
  return value.length === 0 || value.length >= 2;
}

export interface MaintenerAuditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelected: (user: MaintenerAuditUser) => void;
}

export function MaintenerAuditDialog({ open, onOpenChange, onSelected }: MaintenerAuditDialogProps) {
  const dashboardApi = useDashboardApi();
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<MaintenerAuditSearchUser[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [selectingUserId, setSelectingUserId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const searchRequestId = useRef(0);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetUsers = useCallback(() => {
    setUsers([]);
    setHasMore(false);
    setNextOffset(0);
  }, []);

  const loadUsers = useCallback(async (requestId: number, append = false) => {
    const normalizedQuery = query.trim();
    if (!canLoadQuery(normalizedQuery)) {
      resetUsers();
      setIsSearching(false);
      setIsLoadingMore(false);
      return;
    }
    if (append) {
      if (isLoadingMore || isSearching || !hasMore) return;
      setIsLoadingMore(true);
    } else {
      resetUsers();
      setIsSearching(true);
    }
    setErrorMessage("");

    try {
      const result = await dashboardApi.maintener.users.search({
        q: normalizedQuery || undefined,
        offset: append ? nextOffset : 0,
        limit: PAGE_SIZE,
      });
      if (requestId !== searchRequestId.current) return;
      setUsers((current) => (append ? [...current, ...result.users] : result.users));
      setHasMore(result.hasMore);
      setNextOffset(result.nextOffset);
    } catch (error) {
      if (requestId !== searchRequestId.current) return;
      setErrorMessage(error instanceof Error ? error.message : "Failed to load users");
      if (!append) resetUsers();
    } finally {
      if (requestId === searchRequestId.current) {
        setIsSearching(false);
        setIsLoadingMore(false);
      }
    }
  }, [query, isLoadingMore, isSearching, hasMore, nextOffset, dashboardApi, resetUsers]);

  useEffect(() => {
    if (!open) return;
    const requestId = ++searchRequestId.current;
    setQuery("");
    void loadUsers(requestId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const requestId = ++searchRequestId.current;
    setErrorMessage("");
    if (!canLoadQuery(query.trim())) {
      resetUsers();
      setIsSearching(false);
      setIsLoadingMore(false);
      return;
    }
    resetUsers();
    setIsSearching(true);
    setIsLoadingMore(false);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      if (requestId !== searchRequestId.current) return;
      void loadUsers(requestId);
    }, 250);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open]);

  useEffect(() => {
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, []);

  const selectUser = async (user: MaintenerAuditSearchUser) => {
    setSelectingUserId(user.id);
    setErrorMessage("");
    try {
      const result = await dashboardApi.maintener.audit.start({ userId: user.id });
      if (!result.success) throw new Error(result.error);
      onOpenChange(false);
      onSelected(result.data.user);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to start audit mode");
    } finally {
      setSelectingUserId(null);
    }
  };

  const handleUsersScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
    if (distanceFromBottom > SCROLL_LOAD_THRESHOLD) return;
    void loadUsers(searchRequestId.current, true);
  };

  return (
    <UiDialog open={open} onOpenChange={onOpenChange} ui={{ content: "sm:max-w-lg" }}>
      <div className="space-y-1.5 pr-6">
        <h2 className="text-lg font-semibold leading-none tracking-tight">Auditing</h2>
        <p className="text-sm text-muted-foreground sm:hidden">Search account for audit mode.</p>
        <p className="hidden text-sm text-muted-foreground sm:block">Search an account to view it in read-only audit mode.</p>
      </div>

      <label className="grid gap-1.5 text-sm font-medium">
        User
        <div className="relative">
          <UiIcon name="i-lucide-search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            placeholder="Search name or email"
            autoComplete="off"
          />
        </div>
      </label>

      {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}

      <div className="h-72 overflow-y-auto rounded-md border border-border bg-muted/10 p-1" onScroll={handleUsersScroll}>
        {query.trim().length > 0 && query.trim().length < 2 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">Type at least 2 characters.</p>
        ) : isSearching && users.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">Loading users...</p>
        ) : users.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">No users found.</p>
        ) : (
          <>
            {users.map((user) => (
              <button
                key={user.id}
                type="button"
                disabled={Boolean(selectingUserId)}
                className="flex w-full cursor-pointer items-center gap-3 rounded-sm px-2 py-2 text-left transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-default disabled:pointer-events-none disabled:opacity-50"
                onClick={() => void selectUser(user)}
              >
                <span className="relative flex size-9 shrink-0 select-none">
                  <span className="flex size-9 overflow-hidden rounded-full">
                    {user.image ? <img src={user.image} alt="" className="aspect-square size-full" /> : <span className="flex size-full items-center justify-center rounded-full bg-muted text-sm text-muted-foreground">{userInitial(user)}</span>}
                  </span>
                  {user.hasProviderIssue ? (
                    <span className="absolute bottom-0 left-0 z-10 flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
                      <span className="absolute inset-0 inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
                    </span>
                  ) : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{user.name || user.email || "Unnamed user"}</span>
                  <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
                </span>
                {selectingUserId === user.id ? <UiIcon name="i-lucide-loader-circle" className="size-4 shrink-0 animate-spin text-muted-foreground" /> : null}
              </button>
            ))}
            {isLoadingMore ? <p className="px-3 py-3 text-center text-sm text-muted-foreground">Loading more...</p> : null}
          </>
        )}
      </div>
    </UiDialog>
  );
}
