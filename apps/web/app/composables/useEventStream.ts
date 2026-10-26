import type { AccountsData, LiveTopic, ModelsData, ServerEvent, UsageData } from "@opendum/providers/contract";
import { consumeEventIterator } from "@orpc/client";
import { Duration, Effect, Match, Schedule } from "effect";

import { apiUrl } from "~~/lib/api-url";
import { apiClient } from "~~/lib/orpc";
import { liveEventKey } from "~/composables/useLiveEvent";

const SUBSCRIBED_TOPICS: LiveTopic[] = ["points", "accounts", "models", "usage"];
const IDLE_TIMEOUT_MS = 45_000;
const STREAM_WATCHDOG_MS = 15_000;
const RECONNECT_SCHEDULE = Schedule.min([
  Schedule.exponential(Duration.seconds(1)),
  Schedule.spaced(Duration.seconds(30)),
]).pipe(Schedule.jittered);

export interface EventStreamHandlers {
  onPoints?: (balance: number) => void;
  onAccounts?: (data: AccountsData) => void;
  onModels?: (data: ModelsData) => void;
  onUsage?: (data: UsageData) => void;
}

export function useEventStream(handlers: EventStreamHandlers = {}) {
  const config = useRuntimeConfig();
  const auth = useAuth();
  const connected = useState<boolean>("web-events-connected", () => false);
  const accounts = useState<AccountsData | null>(liveEventKey("accounts"), () => null);
  const models = useState<ModelsData | null>(liveEventKey("models"), () => null);
  const usage = useState<UsageData | null>(liveEventKey("usage"), () => null);

  const refreshAuth = async () => {
    if (await auth.refreshAccessToken()) return true;

    auth.expireSession();
    void navigateTo("/");
    return false;
  };

  const baseUrl = apiUrl(config.public.apiUrl);
  let cancel: (() => Promise<void>) | undefined;
  let release: (() => void) | undefined;
  let stopped = false;
  let lastEventAt = Date.now();
  let watchdog: ReturnType<typeof setInterval> | null = null;

  function applyEvent(event: ServerEvent): void {
    Match.value(event).pipe(
      Match.when({ type: "ping" }, () => undefined),
      Match.when({ type: "update", topic: "points" }, (value) => {
        handlers.onPoints?.(value.data.balance);
      }),
      Match.when({ type: "update", topic: "accounts" }, (value) => {
        accounts.value = value.data;
        handlers.onAccounts?.(value.data);
      }),
      Match.when({ type: "update", topic: "models" }, (value) => {
        models.value = value.data;
        handlers.onModels?.(value.data);
      }),
      Match.when({ type: "update", topic: "usage" }, (value) => {
        usage.value = value.data;
        handlers.onUsage?.(value.data);
      }),
      Match.exhaustive,
    );
  }

  function handleEvent(event: ServerEvent) {
    lastEventAt = Date.now();
    applyEvent(event);
  }

  function handleVisibilityChange() {
    if (document.hidden) return;
    restart();
  }

  function restart(): void {
    const staleRelease = release;
    void cancel?.();
    staleRelease?.();
  }

  function startWatchdog() {
    if (watchdog) return;
    watchdog = setInterval(() => {
      if (Date.now() - lastEventAt <= IDLE_TIMEOUT_MS) return;
      restart();
    }, STREAM_WATCHDOG_MS);
  }

  function stopWatchdog() {
    if (!watchdog) return;
    clearInterval(watchdog);
    watchdog = null;
  }

  async function runStream(): Promise<void> {
    lastEventAt = Date.now();
    const client = apiClient({ baseUrl, refresh: refreshAuth });
    const iterator = client.events.subscribe({ topics: SUBSCRIBED_TOPICS });

    await Effect.runPromise(
      Effect.callback<void>((resume) => {
        release = () => resume(Effect.void);
        cancel = consumeEventIterator(iterator, {
          onEvent: handleEvent,
          onError: () => release?.(),
          onSuccess: () => release?.(),
          onFinish: () => {
            connected.value = false;
            release?.();
          },
        });
        connected.value = true;
        startWatchdog();
        return Effect.void;
      })
    );

    release = undefined;
    connected.value = false;
    stopWatchdog();
  }

  async function connect() {
    const resilient = Effect.tryPromise({ try: () => runStream(), catch: (cause) => cause }).pipe(
      Effect.catch((cause) => Effect.sync(() => {
        console.error("Web event stream failed:", cause);
      })),
      Effect.repeat({ schedule: RECONNECT_SCHEDULE, while: () => !stopped }),
    );

    await Effect.runPromise(resilient);
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

  return { connected, accounts, models, usage };
}
