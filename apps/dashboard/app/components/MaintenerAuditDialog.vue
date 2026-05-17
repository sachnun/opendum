<script setup lang="ts">
import type { MaintenerAuditUser } from "../../lib/dashboard-api-types";

const open = defineModel<boolean>("open", { default: false });

const emit = defineEmits<{
  selected: [user: MaintenerAuditUser];
}>();

const dashboardApi = useDashboardApi();
const PAGE_SIZE = 12;
const SCROLL_LOAD_THRESHOLD = 48;

const query = ref("");
const users = ref<MaintenerAuditUser[]>([]);
const isSearching = ref(false);
const isLoadingMore = ref(false);
const hasMore = ref(false);
const nextOffset = ref(0);
const selectingUserId = ref<string | null>(null);
const errorMessage = ref("");
let searchRequestId = 0;
let searchTimer: ReturnType<typeof setTimeout> | null = null;

function userInitial(user: MaintenerAuditUser) {
  return (user.name?.[0] || user.email?.[0] || "U").toUpperCase();
}

function canLoadQuery(value: string) {
  return value.length === 0 || value.length >= 2;
}

function clearSearchTimer() {
  if (!searchTimer) return;
  clearTimeout(searchTimer);
  searchTimer = null;
}

function resetUsers() {
  users.value = [];
  hasMore.value = false;
  nextOffset.value = 0;
}

async function loadUsers(requestId: number, append = false) {
  const normalizedQuery = query.value.trim();
  if (!canLoadQuery(normalizedQuery)) {
    resetUsers();
    isSearching.value = false;
    isLoadingMore.value = false;
    return;
  }

  if (append) {
    if (isLoadingMore.value || isSearching.value || !hasMore.value) return;
    isLoadingMore.value = true;
  } else {
    resetUsers();
    isSearching.value = true;
  }

  errorMessage.value = "";

  try {
    const result = await dashboardApi.maintener.users.search({
      q: normalizedQuery || undefined,
      offset: append ? nextOffset.value : 0,
      limit: PAGE_SIZE,
    });
    if (requestId !== searchRequestId) return;

    users.value = append ? [...users.value, ...result.users] : result.users;
    hasMore.value = result.hasMore;
    nextOffset.value = result.nextOffset;
  } catch (error) {
    if (requestId !== searchRequestId) return;
    errorMessage.value = error instanceof Error ? error.message : "Failed to load users";
    if (!append) resetUsers();
  } finally {
    if (requestId === searchRequestId) {
      isSearching.value = false;
      isLoadingMore.value = false;
    }
  }
}

function handleUsersScroll(event: Event) {
  const target = event.currentTarget as HTMLElement;
  const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
  if (distanceFromBottom > SCROLL_LOAD_THRESHOLD) return;
  void loadUsers(searchRequestId, true);
}

watch(open, (value) => {
  clearSearchTimer();

  if (value) {
    const requestId = ++searchRequestId;
    query.value = "";
    void loadUsers(requestId);
    return;
  }

  searchRequestId++;
  query.value = "";
  resetUsers();
  errorMessage.value = "";
  selectingUserId.value = null;
  isSearching.value = false;
  isLoadingMore.value = false;
});

watch(query, (value) => {
  if (!open.value) return;

  const normalizedQuery = value.trim();
  const requestId = ++searchRequestId;
  clearSearchTimer();

  errorMessage.value = "";
  if (!canLoadQuery(normalizedQuery)) {
    resetUsers();
    isSearching.value = false;
    isLoadingMore.value = false;
    return;
  }

  resetUsers();
  isSearching.value = true;
  isLoadingMore.value = false;
  searchTimer = setTimeout(() => {
    if (requestId !== searchRequestId) return;
    void loadUsers(requestId);
  }, 250);
});

onBeforeUnmount(() => {
  clearSearchTimer();
});

async function selectUser(user: MaintenerAuditUser) {
  selectingUserId.value = user.id;
  errorMessage.value = "";

  try {
    const result = await dashboardApi.maintener.audit.start({ userId: user.id });
    if (!result.success) throw new Error(result.error);
    open.value = false;
    emit("selected", result.data.user);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Failed to start audit mode";
  } finally {
    selectingUserId.value = null;
  }
}
</script>

<template>
  <UiDialog v-model:open="open" :ui="{ content: 'sm:max-w-lg' }">
    <template #content>
      <div class="space-y-1.5 pr-6">
        <h2 class="text-lg font-semibold leading-none tracking-tight">Audit User</h2>
        <p class="text-sm text-muted-foreground sm:hidden">Search account for audit mode.</p>
        <p class="hidden text-sm text-muted-foreground sm:block">Search an account to view it in read-only audit mode.</p>
      </div>

      <label class="grid gap-1.5 text-sm font-medium">
        User
        <div class="relative">
          <UiIcon name="i-lucide-search" class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            v-model="query"
            class="h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            placeholder="Search name or email"
            autocomplete="off"
          >
        </div>
      </label>

      <p v-if="errorMessage" class="text-sm text-destructive">{{ errorMessage }}</p>

      <div class="max-h-72 overflow-y-auto rounded-md border border-border bg-muted/10 p-1" @scroll="handleUsersScroll">
        <p v-if="query.trim().length > 0 && query.trim().length < 2" class="px-3 py-6 text-center text-sm text-muted-foreground">Type at least 2 characters.</p>
        <p v-else-if="isSearching && users.length === 0" class="px-3 py-6 text-center text-sm text-muted-foreground">Loading users...</p>
        <p v-else-if="users.length === 0" class="px-3 py-6 text-center text-sm text-muted-foreground">No users found.</p>
        <template v-else>
          <button
            v-for="user in users"
            :key="user.id"
            type="button"
            class="flex w-full cursor-pointer items-center gap-3 rounded-sm px-2 py-2 text-left transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-default disabled:pointer-events-none disabled:opacity-50"
            :disabled="Boolean(selectingUserId)"
            @click="selectUser(user)"
          >
            <span class="relative flex size-9 shrink-0 overflow-hidden rounded-full select-none">
              <img v-if="user.image" :src="user.image" alt="" class="aspect-square size-full">
              <span v-else class="flex size-full items-center justify-center rounded-full bg-muted text-sm text-muted-foreground">
                {{ userInitial(user) }}
              </span>
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium">{{ user.name || user.email || 'Unnamed user' }}</span>
              <span class="block truncate text-xs text-muted-foreground">{{ user.email }}</span>
            </span>
            <UiIcon v-if="selectingUserId === user.id" name="i-lucide-loader-circle" class="size-4 animate-spin text-muted-foreground" />
          </button>
          <p v-if="isLoadingMore" class="px-3 py-3 text-center text-sm text-muted-foreground">Loading more...</p>
        </template>
      </div>
    </template>
  </UiDialog>
</template>
