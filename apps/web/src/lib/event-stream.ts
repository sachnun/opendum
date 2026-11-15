import type { AccountsData, LiveTopic, ModelsData, ServerEvent, UsageData } from "@opendum/providers/contract";
import { consumeEventIterator } from "@orpc/client";
import { Duration, Effect, Match, Schedule } from "effect";

import { baseApiUrl } from "~/lib/config";
import { apiClient } from "~/lib/orpc";
import { refreshAccessToken } from "~/lib/auth";
import { setLiveTopic } from "~/lib/live-event";

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
  onConnectionChange?: (connected: boolean) => void;
}

export function startEventStream(handlers: EventStreamHandlers = {}): () => void {
  const baseUrl = baseApiUrl();
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
        setLiveTopic("accounts", value.data);
        handlers.onAccounts?.(value.data);
      }),
      Match.when({ type: "update", topic: "models" }, (value) => {
        setLiveTopic("models", value.data);
        handlers.onModels?.(value.data);
      }),
      Match.when({ type: "update", topic: "usage" }, (value) => {
        setLiveTopic("usage", value.data);
        handlers.onUsage?.(value.data);
      }),
      Match.exhaustive
    );
    lastEventAt = Date.now();
  }

  function restart(): void {
    const staleRelease = release;
    void cancel?.();
    staleRelease?.();
  }

  function handleVisibilityChange() {
    if (document.hidden) return;
    restart();
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
    const client = apiClient({
      baseUrl,
      refresh: refreshAccessToken,
      expire: () => undefined,
    });
    const iterator = client.events.subscribe({ topics: SUBSCRIBED_TOPICS });

    await Effect.runPromise(
      Effect.callback<void>((resume) => {
        release = () => resume(Effect.void);
        cancel = consumeEventIterator(iterator, {
          onEvent: (event) => applyEvent(event as ServerEvent),
          onError: () => release?.(),
          onSuccess: () => release?.(),
          onFinish: () => {
            handlers.onConnectionChange?.(false);
            release?.();
          },
        });
        handlers.onConnectionChange?.(true);
        startWatchdog();
        return Effect.void;
      })
    );

    release = undefined;
    handlers.onConnectionChange?.(false);
    stopWatchdog();
  }

  async function connect() {
    const resilient = Effect.tryPromise({ try: () => runStream(), catch: (cause) => cause }).pipe(
      Effect.catch(() => Effect.sync(() => undefined)),
      Effect.repeat({ schedule: RECONNECT_SCHEDULE, while: () => !stopped })
    );

    await Effect.runPromise(resilient);
  }

  document.addEventListener("visibilitychange", handleVisibilityChange);
  void connect();

  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    stopWatchdog();
    void cancel?.();
  };
}
