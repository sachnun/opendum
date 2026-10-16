import type { LiveTopic, ServerEvent } from "@opendum/providers/contract";
import { consumeEventIterator } from "@orpc/client";

import { resolveApiUrl } from "../../lib/api-url";
import { createApiClient } from "../../lib/orpc";
import { liveEventVersionKey } from "./useLiveEvent";

const SUBSCRIBED_TOPICS: LiveTopic[] = ["points", "accounts", "models", "usage"];
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const STREAM_IDLE_TIMEOUT_MS = 45_000;
const STREAM_WATCHDOG_MS = 15_000;

export interface EventStreamHandlers {
  onPoints?: (balance: number) => void;
  onAccounts?: () => void;
  onModels?: () => void;
  onUsage?: () => void;
  onResync?: () => void;
}

export function useEventStream(handlers: EventStreamHandlers = {}) {
  const config = useRuntimeConfig();
  const auth = useAuth();
  const connected = useState<boolean>("web-events-connected", () => false);
  const versions = {} as Record<LiveTopic, { value: number }>;
  for (const topic of SUBSCRIBED_TOPICS) versions[topic] = useState<number>(liveEventVersionKey(topic), () => 0);

  const refreshAuth = async () => {
    if (await auth.refreshAccessToken()) return true;

    auth.expireSession();
    void navigateTo("/");
    return false;
  };

  const baseUrl = resolveApiUrl(config.public.apiUrl);
  let cancel: (() => Promise<void>) | undefined;
  let release: (() => void) | undefined;
  let stopped = false;
  let firstConnect = true;
  let attempt = 0;
  let lastEventAt = Date.now();
  let watchdog: ReturnType<typeof setInterval> | null = null;

  function bump(topic: LiveTopic) {
    versions[topic].value += 1;
  }

  function resync() {
    handlers.onResync?.();
    for (const topic of SUBSCRIBED_TOPICS) bump(topic);
  }

  function handleVisibilityChange() {
    if (document.hidden) return;
    resync();
  }

  function startWatchdog() {
    if (watchdog) return;
    watchdog = setInterval(() => {
      if (Date.now() - lastEventAt <= STREAM_IDLE_TIMEOUT_MS) return;
      const staleRelease = release;
      void cancel?.();
      staleRelease?.();
    }, STREAM_WATCHDOG_MS);
  }

  function stopWatchdog() {
    if (!watchdog) return;
    clearInterval(watchdog);
    watchdog = null;
  }

  function handleEvent(event: ServerEvent) {
    lastEventAt = Date.now();
    attempt = 0;

    if (event.type === "update" && event.topic === "points") {
      bump("points");
      handlers.onPoints?.(event.data.balance);
      return;
    }

    if (event.type !== "tick") return;

    bump(event.topic);
    if (event.topic === "accounts") handlers.onAccounts?.();
    else if (event.topic === "models") handlers.onModels?.();
    else handlers.onUsage?.();
  }

  async function connect() {
    while (!stopped) {
      try {
        const client = createApiClient({ baseUrl, refresh: refreshAuth });
        const iterator = client.events.subscribe({ topics: SUBSCRIBED_TOPICS });

        await new Promise<void>((resolve) => {
          release = resolve;
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
          startWatchdog();
          if (firstConnect) {
            firstConnect = false;
            return;
          }

          resync();
        });
      } catch {
        connected.value = false;
      }

      release = undefined;
      connected.value = false;
      stopWatchdog();
      if (stopped) return;

      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt)));
    }
  }

  onMounted(() => {
    if (!import.meta.client) return;
    document.addEventListener("visibilitychange", handleVisibilityChange);
    void connect();
  });

  onBeforeUnmount(() => {
    stopped = true;
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    stopWatchdog();
    void cancel?.();
  });

  return { connected };
}
