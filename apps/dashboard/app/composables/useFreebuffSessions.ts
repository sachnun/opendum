import type { ComputedRef } from "vue";
import type { FreebuffSessionBatchData, ProviderDetailData } from "../../lib/api-types";

type Account = ProviderDetailData["accounts"][number];

const POLL_INTERVAL_MS = 10_000;

export function useFreebuffSessions(accounts: ComputedRef<Account[]>) {
  const api = useApi();
  const sessions = useState<FreebuffSessionBatchData>(stateKeys.freebuffSessionsByAccountId, () => ({}));
  let timer: ReturnType<typeof setInterval> | null = null;

  async function refresh() {
    const accountIds = accounts.value.filter((account) => account.provider === "freebuff").map((account) => account.id);
    if (accountIds.length === 0) {
      sessions.value = {};
      return;
    }
    try {
      sessions.value = await api.accounts.freebuffSessions({ accountIds });
    } catch {
      // Keep the last snapshot on transient failures.
    }
  }

  onMounted(() => {
    void refresh();
    timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
  });

  onBeforeUnmount(() => {
    if (timer) clearInterval(timer);
    timer = null;
  });

  return { sessions, refresh };
}
