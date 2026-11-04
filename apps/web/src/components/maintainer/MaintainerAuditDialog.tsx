import { For, Show, createEffect, createSignal, on, onCleanup, type JSX } from "solid-js";
import type { AuditSearchUser, MaintainerAuditUser } from "~/lib/api-types";
import { api } from "~/api";
import { errorText, settle } from "~/lib/settle";
import { avatarUrl } from "~/lib/utils";
import { UiDialog } from "~/components/ui/UiDialog";
import { UiIcon } from "~/components/ui/UiIcon";

const PAGE_SIZE = 12;
const SCROLL_LOAD_THRESHOLD = 48;

export interface MaintainerAuditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelected: (user: MaintainerAuditUser) => void;
}

function userInitial(user: AuditSearchUser): string {
  return (user.name?.[0] || user.email?.[0] || "U").toUpperCase();
}

export function MaintainerAuditDialog(props: MaintainerAuditDialogProps): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [users, setUsers] = createSignal<AuditSearchUser[]>([]);
  const [isSearching, setIsSearching] = createSignal(false);
  const [isLoadingMore, setIsLoadingMore] = createSignal(false);
  const [hasMore, setHasMore] = createSignal(false);
  const [nextOffset, setNextOffset] = createSignal(0);
  const [selectingUserId, setSelectingUserId] = createSignal<string | null>(null);
  const [errorMessage, setErrorMessage] = createSignal("");

  let searchRequestId = 0;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  function canLoad(value: string): boolean {
    return value.length === 0 || value.length >= 2;
  }

  function clearTimer() {
    if (!searchTimer) return;
    clearTimeout(searchTimer);
    searchTimer = null;
  }

  function resetUsers() {
    setUsers([]);
    setHasMore(false);
    setNextOffset(0);
  }

  async function loadUsers(requestId: number, append = false) {
    const normalizedQuery = query().trim();
    if (!canLoad(normalizedQuery)) {
      resetUsers();
      setIsSearching(false);
      setIsLoadingMore(false);
      return;
    }

    if (append) {
      if (isLoadingMore() || isSearching() || !hasMore()) return;
      setIsLoadingMore(true);
    } else {
      resetUsers();
      setIsSearching(true);
    }

    setErrorMessage("");

    const searched = await settle(() =>
      api.maintainer.users.search({
        q: normalizedQuery || undefined,
        offset: append ? nextOffset() : 0,
        limit: PAGE_SIZE,
      })
    );
    if (requestId !== searchRequestId) return;
    if (searched.ok) {
      const result = searched.value;
      setUsers(append ? [...users(), ...result.users] : result.users);
      setHasMore(result.hasMore);
      setNextOffset(result.nextOffset);
    } else {
      setErrorMessage(errorText(searched.error, "Failed to load users"));
      if (!append) resetUsers();
    }
    setIsSearching(false);
    setIsLoadingMore(false);
  }

  function usersScroll(event: Event) {
    const target = event.currentTarget as HTMLElement;
    const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
    if (distanceFromBottom > SCROLL_LOAD_THRESHOLD) return;
    void loadUsers(searchRequestId, true);
  }

  createEffect(
    on(() => props.open, (value) => {
      clearTimer();

      if (value) {
        const requestId = ++searchRequestId;
        setQuery("");
        void loadUsers(requestId);
        return;
      }

      searchRequestId++;
      setQuery("");
      resetUsers();
      setErrorMessage("");
      setSelectingUserId(null);
      setIsSearching(false);
      setIsLoadingMore(false);
    })
  );

  createEffect(
    on(query, (value) => {
      if (!props.open) return;

      const normalizedQuery = value.trim();
      const requestId = ++searchRequestId;
      clearTimer();

      setErrorMessage("");
      if (!canLoad(normalizedQuery)) {
        resetUsers();
        setIsSearching(false);
        setIsLoadingMore(false);
        return;
      }

      resetUsers();
      setIsSearching(true);
      setIsLoadingMore(false);
      searchTimer = setTimeout(() => {
        if (requestId !== searchRequestId) return;
        void loadUsers(requestId);
      }, 250);
    })
  );

  onCleanup(() => clearTimer());

  async function selectUser(user: AuditSearchUser) {
    setSelectingUserId(user.id);
    setErrorMessage("");

    const started = await settle(() => api.maintainer.audit.start({ userId: user.id }));
    setSelectingUserId(null);
    if (!started.ok) {
      setErrorMessage(errorText(started.error, "Failed to start audit mode"));
      return;
    }
    if (!started.value.success) {
      setErrorMessage(started.value.error);
      return;
    }
    props.onOpenChange(false);
    props.onSelected(started.value.data.user);
  }

  return (
    <UiDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      ui={{ content: "sm:max-w-lg" }}
      content={
        <>
          <div class="space-y-1.5 pr-6">
            <h2 class="text-lg font-semibold leading-none tracking-tight">Auditing</h2>
            <p class="text-sm text-muted-foreground sm:hidden">Search account for audit mode.</p>
            <p class="hidden text-sm text-muted-foreground sm:block">Search an account to view it in read-only audit mode.</p>
          </div>

          <label class="grid gap-1.5 text-sm font-medium">
            User
            <div class="relative">
              <UiIcon name="i-lucide-search" class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
                class="h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                placeholder="Search name or email"
                autocomplete="off"
              />
            </div>
          </label>

          <Show when={errorMessage()}>
            <p class="text-sm text-destructive">{errorMessage()}</p>
          </Show>

          <div class="h-72 overflow-y-auto rounded-md border border-border bg-muted/10 p-1" onScroll={usersScroll}>
            <Show when={query().trim().length > 0 && query().trim().length < 2}>
              <p class="px-3 py-6 text-center text-sm text-muted-foreground">Type at least 2 characters.</p>
            </Show>
            <Show when={!(query().trim().length > 0 && query().trim().length < 2) && isSearching() && users().length === 0}>
              <p class="px-3 py-6 text-center text-sm text-muted-foreground">Loading users...</p>
            </Show>
            <Show when={!(query().trim().length > 0 && query().trim().length < 2) && !(isSearching() && users().length === 0) && users().length === 0}>
              <p class="px-3 py-6 text-center text-sm text-muted-foreground">No users found.</p>
            </Show>
            <Show when={users().length > 0}>
              <For each={users()}>
                {(user) => (
                  <button
                    type="button"
                    class="flex w-full cursor-pointer items-center gap-3 rounded-sm px-2 py-2 text-left transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-default disabled:pointer-events-none disabled:opacity-50"
                    disabled={Boolean(selectingUserId())}
                    onClick={() => void selectUser(user)}
                  >
                    <span class="relative flex size-9 shrink-0 select-none">
                      <span class="flex size-9 overflow-hidden rounded-full">
                        <Show
                          when={user.image}
                          fallback={
                            <span class="flex size-full items-center justify-center rounded-full bg-muted text-sm text-muted-foreground">
                              {userInitial(user)}
                            </span>
                          }
                        >
                          <img src={avatarUrl(user.image as string)} alt="" class="aspect-square size-full" />
                        </Show>
                      </span>
                      <Show when={user.hasProviderIssue}>
                        <span class="absolute bottom-0 left-0 z-10 flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
                          <span class="absolute inset-0 inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                          <span class="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
                        </span>
                      </Show>
                    </span>
                    <span class="min-w-0 flex-1">
                      <span class="block truncate text-sm font-medium">{user.name || user.email || "Unnamed user"}</span>
                      <span class="block truncate text-xs text-muted-foreground">{user.email}</span>
                    </span>
                    <Show when={selectingUserId() === user.id}>
                      <UiIcon name="i-lucide-loader-circle" class="size-4 shrink-0 animate-spin text-muted-foreground" />
                    </Show>
                  </button>
                )}
              </For>
              <Show when={isLoadingMore()}>
                <p class="px-3 py-3 text-center text-sm text-muted-foreground">Loading more...</p>
              </Show>
            </Show>
          </div>
        </>
      }
    />
  );
}
