import type { AccountsData, LiveTopic, ModelsData, ServerEvent, UsageData } from "@opendum/providers/contract";
import { EventPublisher } from "@orpc/server";
import { Duration, Effect, Match, Queue, Ref, Stream } from "effect";

import { proxyEvents } from "@opendum/api/core/events";

const POINTS_DEBOUNCE = Duration.millis(1_500);
const SNAPSHOT_DEBOUNCE = Duration.millis(400);
const USAGE_THROTTLE = Duration.millis(10_000);
const HEARTBEAT_INTERVAL = Duration.millis(20_000);

export interface EventSnapshots {
  accounts: AccountsData;
  models: ModelsData;
  usage: UsageData;
}

export type SnapshotBuilder = (
  userId: string,
  topics: LiveTopic[]
) => Effect.Effect<Partial<EventSnapshots>, import("@opendum/api/web/errors").ServiceFailure>;

type TopicSignal = { userId: string; topic: LiveTopic };
type UsageSignal = { userId: string };
type PointsSignal = { userId: string; balance: number };

const publisher = new EventPublisher<Record<string, ServerEvent>>({ maxBufferedEvents: 32 });

const activeUserIds = new Set<string>();

const topicSignals = Effect.runSync(Queue.unbounded<TopicSignal>());
const usageSignals = Effect.runSync(Queue.unbounded<UsageSignal>());
const pointsSignals = Effect.runSync(Queue.unbounded<PointsSignal>());

const usagePublishedAt = Effect.runSync(Ref.make(new Map<string, number>()));

let buildSnapshots: SnapshotBuilder = () => Effect.succeed({});

export function configureSnapshots(builder: SnapshotBuilder): void {
  buildSnapshots = builder;
}

function now(): string {
  return new Date().toISOString();
}

export function publishUser(userId: string, event: ServerEvent): void {
  publisher.publish(userId, event);
}

function updateEvent(topic: LiveTopic, snapshots: Partial<EventSnapshots>): ServerEvent | null {
  return Match.value(topic).pipe(
    Match.when("accounts", () => (snapshots.accounts ? { type: "update" as const, topic: "accounts" as const, at: now(), data: snapshots.accounts } : null)),
    Match.when("models", () => (snapshots.models ? { type: "update" as const, topic: "models" as const, at: now(), data: snapshots.models } : null)),
    Match.when("usage", () => (snapshots.usage ? { type: "update" as const, topic: "usage" as const, at: now(), data: snapshots.usage } : null)),
    Match.orElse(() => null),
  );
}

const publishTopic = Effect.fn("events.publishTopic")(function* (userId: string, topic: LiveTopic) {
  if (!activeUserIds.has(userId)) return;
  const snapshots = yield* buildSnapshots(userId, [topic]);
  const event = updateEvent(topic, snapshots);
  if (event) publishUser(userId, event);
});

const publishUsageEvent = Effect.fn("events.publishUsage")(function* (userId: string) {
  if (!activeUserIds.has(userId)) return;
  yield* Ref.update(usagePublishedAt, (current) => {
    const next = new Map(current);
    next.set(userId, Date.now());
    return next;
  });
  yield* publishTopic(userId, "usage");
});

const publishPointsEvent = Effect.fn("events.publishPoints")(function* (userId: string, balance: number) {
  if (!activeUserIds.has(userId)) return;
  yield* Effect.sync(() => {
    publishUser(userId, { type: "update", topic: "points", at: now(), data: { balance } });
  });
});

function runBackground(effect: Effect.Effect<unknown>): void {
  Effect.runFork(Effect.ignore(effect));
}

function topicStream(): void {
  runBackground(
    Stream.fromQueue(topicSignals).pipe(
      Stream.groupByKey((signal) => `${signal.userId}:${signal.topic}`, {
        idleTimeToLive: Duration.seconds(30),
      }),
      Stream.map(([key, stream]) =>
        stream.pipe(
          Stream.debounce(SNAPSHOT_DEBOUNCE),
          Stream.runForEach((signal) => publishTopic(signal.userId, signal.topic)),
          Effect.catchCause((cause) =>
            Effect.logError(`Failed to publish ${key} event`, cause)
          )
        )
      ),
      Stream.runForEach((run) => run),
      Effect.catchCause(() => Effect.void)
    )
  );
}

function usageStream(): void {
  runBackground(
    Stream.fromQueue(usageSignals).pipe(
      Stream.groupByKey((signal) => signal.userId, { idleTimeToLive: Duration.seconds(30) }),
      Stream.map(([userId, stream]) =>
        stream.pipe(
          Stream.throttle({
            cost: () => 1,
            units: 1,
            duration: USAGE_THROTTLE,
            strategy: "enforce",
          }),
          Stream.debounce(USAGE_THROTTLE),
          Stream.runForEach(() => publishUsageEvent(userId)),
          Effect.catchCause((cause) => Effect.logError(`Failed to publish usage for ${userId}`, cause))
        )
      ),
      Stream.runForEach((run) => run),
      Effect.catchCause(() => Effect.void)
    )
  );
}

function pointsStream(): void {
  runBackground(
    Stream.fromQueue(pointsSignals).pipe(
      Stream.groupByKey((signal) => signal.userId, { idleTimeToLive: Duration.seconds(30) }),
      Stream.map(([userId, stream]) =>
        stream.pipe(
          Stream.debounce(POINTS_DEBOUNCE),
          Stream.runForEach((signal) => publishPointsEvent(userId, signal.balance)),
          Effect.catchCause((cause) => Effect.logError(`Failed to publish points for ${userId}`, cause))
        )
      ),
      Stream.runForEach((run) => run),
      Effect.catchCause(() => Effect.void)
    )
  );
}

function runHeartbeat(): void {
  runBackground(
    Stream.tick(HEARTBEAT_INTERVAL).pipe(
      Stream.runForEach(() =>
        Effect.sync(() => {
          for (const userId of activeUserIds) publishUser(userId, { type: "ping", at: now() });
        })
      ),
      Effect.catchCause(() => Effect.void)
    )
  );
}

let workersStarted = false;

function startWorkers(): void {
  if (workersStarted) return;
  workersStarted = true;
  topicStream();
  usageStream();
  pointsStream();
}

runHeartbeat();

export function publishModels(userId: string): void {
  scheduleTopic(userId, "models");
}

export function publishAccounts(userId: string): void {
  scheduleTopic(userId, "accounts");
}

function scheduleTopic(userId: string, topic: LiveTopic): void {
  if (!activeUserIds.has(userId)) return;
  Effect.runSync(Queue.offer(topicSignals, { userId, topic }));
}

export function publishUsage(userId: string): void {
  if (!activeUserIds.has(userId)) return;
  Effect.runSync(Queue.offer(usageSignals, { userId }));
}

export function publishPoints(userId: string, balance: number): void {
  Effect.runSync(Queue.offer(pointsSignals, { userId, balance }));
}

async function* initialEvents(userId: string, topics: LiveTopic[]): AsyncGenerator<ServerEvent, void> {
  const snapshots = await Effect.runPromise(buildSnapshots(userId, topics));
  for (const topic of topics) {
    const event = updateEvent(topic, snapshots);
    if (event) yield event;
  }
}

export async function* subscribeEvents(userId: string, topics: LiveTopic[], signal?: AbortSignal): AsyncGenerator<ServerEvent, void> {
  const wanted = new Set<LiveTopic>(topics);
  activeUserIds.add(userId);
  startWorkers();

  try {
    yield* initialEvents(userId, topics);

    for await (const event of publisher.subscribe(userId, { signal })) {
      if (event.type === "ping" || wanted.has(event.topic)) yield event;
    }
  } finally {
    activeUserIds.delete(userId);
    await Effect.runPromise(Ref.update(usagePublishedAt, (current) => {
      const next = new Map(current);
      next.delete(userId);
      return next;
    }));
  }
}

proxyEvents.onUsageLogged((userId) => publishUsage(userId));
