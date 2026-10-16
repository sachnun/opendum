import type { LiveTopic, ServerEvent } from "@opendum/providers/contract";
import { consumeEventIterator } from "@orpc/client";

import { resolveApiUrl } from "../../lib/api-url";
import { createApiClient } from "../../lib/orpc";

const SUBSCRIBED_TOPICS: LiveTopic[] = ["points", "accounts", "models"];
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface EventStreamHandlers {
  onPoints?: (balance: number) => void;
  onAccounts?: () => void;
  onModels?: () => void;
  onResync?: () => void;
}

export function useEventStream(handlers: EventStreamHandlers = {}) {
  const config = useRuntimeConfig();
  const auth = useAuth();
  const connected = useState<boolean>("web-events-connected", () => false);

  const refreshAuth = async () => {
    if (await auth.refreshAccessToken()) return true;

    auth.expireSession();
    void navigateTo("/");
    return false;
  };

  const baseUrl = resolveApiUrl(config.public.apiUrl);
  let cancel: (() => Promise<void>) | undefined;
  let stopped = false;
  let firstConnect = true;

  function handleEvent(event: ServerEvent) {
    if (event.type === "update" && event.topic === "points") {
      handlers.onPoints?.(event.data.balance);
      return;
    }

    if (event.type === "tick") {
      if (event.topic === "accounts") handlers.onAccounts?.();
      else handlers.onModels?.();
    }
  }

  async function connect() {
    let attempt = 0;

    while (!stopped) {
      try {
        const client = createApiClient({ baseUrl, refresh: refreshAuth });
        const iterator = client.events.subscribe({ topics: SUBSCRIBED_TOPICS });

        await new Promise<void>((resolve) => {
          cancel = consumeEventIterator(iterator, {
            onEvent: handleEvent,
            onError: () => resolve(),
            onSuccess: () => resolve(),
            onFinish: () => {
              connected.value = false;
              resolve();
            },
          });

          connected.value = true;
          if (firstConnect) firstConnect = false;
          else handlers.onResync?.();
        });
      } catch {
        connected.value = false;
      }

      if (stopped) return;

      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt)));
    }
  }

  onMounted(() => {
    if (!import.meta.client) return;
    void connect();
  });

  onBeforeUnmount(() => {
    stopped = true;
    void cancel?.();
  });

  return { connected };
}
