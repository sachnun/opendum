<script setup lang="ts">
import { getProviderLabel } from "../../lib/provider-accounts";

type AccessMode = "all" | "whitelist" | "blacklist";

interface ProviderAccountOption {
  id: string;
  provider: string;
  name: string;
  email: string | null;
}

const props = defineProps<{
  apiKeyId: string;
  availableAccounts: ProviderAccountOption[];
  initialMode: AccessMode;
  initialAccounts: string[];
  readonly?: boolean;
}>();

const emit = defineEmits<{
  updated: [value: { mode: AccessMode; accounts: string[] }];
}>();

const dashboardApi = useDashboardApi();
const accountPickerOpen = ref(false);
const accountSearch = ref("");
const isSaving = ref(false);
const savedMode = ref<AccessMode>(props.initialMode);
const savedAccounts = ref<string[]>(normalizeAccounts(props.initialAccounts));
const draftMode = ref<AccessMode>(props.initialMode);
const draftAccounts = ref<string[]>(normalizeAccounts(props.initialAccounts));
const errorMessage = ref("");

function normalizeAccounts(accounts: string[]): string[] {
  return Array.from(new Set(accounts)).sort((a, b) => a.localeCompare(b));
}

function sameList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function getModeLabel(mode: AccessMode): string {
  if (mode === "all") return "All accounts";
  if (mode === "whitelist") return "Whitelist";
  return "Blacklist";
}

function getAccountLabel(account: ProviderAccountOption): string {
  return account.email ? `${account.name} (${account.email})` : account.name;
}

function getProviderDisplayName(provider: string): string {
  return getProviderLabel(provider);
}

function toggleAccount(accountId: string) {
  if (props.readonly) return;
  draftAccounts.value = draftAccounts.value.includes(accountId)
    ? draftAccounts.value.filter((id) => id !== accountId)
    : normalizeAccounts([...draftAccounts.value, accountId]);
}

function resetDraftState() {
  draftMode.value = savedMode.value;
  draftAccounts.value = [...savedAccounts.value];
  accountPickerOpen.value = false;
  accountSearch.value = "";
  errorMessage.value = "";
}

async function save() {
  if (props.readonly) return;
  const accountsForSave = draftMode.value === "all" ? [] : normalizedDraftAccounts.value;
  if (draftMode.value !== "all" && accountsForSave.length === 0) {
    errorMessage.value = "Select at least one account";
    return;
  }

  isSaving.value = true;
  errorMessage.value = "";
  try {
    const result = await dashboardApi.apiKeys.updateAccountAccess({ id: props.apiKeyId, mode: draftMode.value, accounts: accountsForSave });
    if (!result.success) throw new Error(result.error);
    savedMode.value = result.data.mode;
    savedAccounts.value = normalizeAccounts(result.data.accounts);
    draftMode.value = result.data.mode;
    draftAccounts.value = [...savedAccounts.value];
    accountPickerOpen.value = false;
    emit("updated", { mode: result.data.mode, accounts: savedAccounts.value });
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Failed to update account access";
  } finally {
    isSaving.value = false;
  }
}

const normalizedDraftAccounts = computed(() => normalizeAccounts(draftAccounts.value));
const normalizedSavedAccounts = computed(() => normalizeAccounts(savedAccounts.value));
const hasChanges = computed(() => draftMode.value !== savedMode.value || !sameList(draftMode.value === "all" ? [] : normalizedDraftAccounts.value, savedMode.value === "all" ? [] : normalizedSavedAccounts.value));
const accountMap = computed(() => new Map(props.availableAccounts.map((account) => [account.id, account])));
const filteredAccounts = computed(() => {
  const query = accountSearch.value.trim().toLowerCase();
  if (!query) return props.availableAccounts;
  return props.availableAccounts.filter((account) => `${account.provider} ${account.name} ${account.email ?? ""}`.toLowerCase().includes(query));
});
</script>

<template>
  <section class="flex h-full flex-col p-4 max-lg:p-0">
    <div class="hidden items-start justify-between gap-3 lg:flex">
      <div class="inline-flex items-center gap-2 text-sm font-semibold">
        <UiIcon name="i-lucide-shield-check" class="size-4 text-muted-foreground" />
        <span>Account Access</span>
      </div>
      <UiBadge variant="outline" class="shrink-0">{{ getModeLabel(savedMode) }}</UiBadge>
    </div>

    <div class="flex-1 space-y-3 lg:mt-5">
      <div class="grid grid-cols-3 gap-1 rounded-md border border-input bg-input/30 p-1">
        <button v-for="mode in ['all', 'whitelist', 'blacklist']" :key="mode" type="button" :disabled="readonly" :class="['h-8 rounded-sm px-2 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-60', draftMode === mode ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground']" @click="draftMode = mode as AccessMode">
          {{ mode === 'all' ? 'All' : mode === 'whitelist' ? 'Whitelist' : 'Blacklist' }}
        </button>
      </div>

      <div v-if="draftMode !== 'all'" class="space-y-2">
        <div class="flex items-center justify-between gap-2">
          <p class="text-xs font-medium">Accounts</p>
          <UiButton type="button" variant="ghost" size="sm" class="h-7 px-2 text-[11px]" :disabled="normalizedDraftAccounts.length === 0 || isSaving || readonly" @click="draftAccounts = []">Clear</UiButton>
        </div>

        <UiPopover v-model:open="accountPickerOpen" :content="{ align: 'start', class: 'w-[min(90vw,28rem)] p-0' }">
          <UiButton variant="outline" class="h-9 w-full justify-between px-3 text-xs" :disabled="isSaving || readonly">
            <span class="truncate">{{ normalizedDraftAccounts.length > 0 ? `${normalizedDraftAccounts.length} account selected` : 'Select accounts' }}</span>
            <UiIcon name="i-lucide-chevron-down" class="size-3.5 text-muted-foreground" />
          </UiButton>
          <template #content>
            <div class="border-b border-border p-2">
              <input v-model="accountSearch" placeholder="Search account..." class="h-8 w-full rounded-md bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring">
            </div>
            <div class="max-h-72 overflow-y-auto p-1">
              <button v-for="account in filteredAccounts" :key="account.id" type="button" :disabled="readonly" class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent disabled:pointer-events-none disabled:opacity-60" @click="toggleAccount(account.id)">
                <UiIcon name="i-lucide-check" :class="['size-3.5', normalizedDraftAccounts.includes(account.id) ? 'opacity-100' : 'opacity-0']" />
                <div class="flex min-w-0 flex-col">
                  <span class="truncate text-xs font-medium">{{ account.name }}</span>
                  <span class="truncate text-[11px] text-muted-foreground">{{ getProviderDisplayName(account.provider) }}{{ account.email ? ` - ${account.email}` : '' }}</span>
                </div>
              </button>
              <p v-if="filteredAccounts.length === 0" class="px-2 py-6 text-center text-xs text-muted-foreground">No account found.</p>
            </div>
          </template>
        </UiPopover>

        <div class="max-h-40 overflow-y-auto py-1">
          <p v-if="normalizedDraftAccounts.length === 0" class="px-1 text-[11px] text-muted-foreground">No accounts selected</p>
          <div v-else class="flex flex-wrap gap-1.5">
            <UiBadge v-for="accountId in normalizedDraftAccounts" :key="accountId" variant="secondary" class="max-w-full gap-1 pr-1 text-[10px] font-normal">
              <span class="min-w-0 truncate">{{ accountMap.get(accountId) ? getAccountLabel(accountMap.get(accountId)!) : accountId }}</span>
              <UiTooltip text="Remove">
                <button type="button" :disabled="readonly" :aria-label="`Remove account ${accountMap.get(accountId) ? getAccountLabel(accountMap.get(accountId)!) : accountId}`" class="inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-60" @click="toggleAccount(accountId)">
                  <UiIcon name="i-lucide-x" class="size-2.5" />
                </button>
              </UiTooltip>
            </UiBadge>
          </div>
        </div>
      </div>
      <p v-if="errorMessage" class="text-xs text-destructive">{{ errorMessage }}</p>
    </div>

    <div class="flex items-center justify-end gap-2 border-t border-border/60 pt-3 lg:mt-4">
      <UiButton variant="outline" size="sm" :disabled="isSaving || !hasChanges || readonly" @click="resetDraftState"><UiIcon name="i-lucide-rotate-ccw" class="size-3.5" />Reset</UiButton>
      <UiButton size="sm" :disabled="isSaving || !hasChanges || readonly" @click="save">{{ isSaving ? 'Saving...' : 'Save' }}</UiButton>
    </div>
  </section>
</template>
